"""HTTP fetching with a content-addressed local cache.

Design rules this module exists to enforce:

1. **Idempotent.** Re-running the ETL without --refresh reuses cached bytes and
   produces byte-identical output. With --refresh, every source is re-fetched
   and the cache is rewritten.

2. **Fail loudly.** There is no "return None on error" path. A failed fetch
   raises FetchError and aborts the run. Emitting a partial /data artifact that
   silently drops a country is worse than emitting nothing, because the app has
   no way to tell the difference between "no data upstream" and "our fetch
   broke" -- and the brief requires those render differently.

3. **Record provenance.** Every fetch returns a CachedResponse carrying the
   URL, the fetch timestamp, the payload sha256, and whatever upstream release
   identifier the server offered (ETag / Last-Modified). The manifest is built
   from these, and the app's freshness panel reads the manifest.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from . import config


class FetchError(RuntimeError):
    """Raised when a source cannot be retrieved. Always aborts the run."""


@dataclass(frozen=True)
class CachedResponse:
    """A fetched payload plus everything needed to cite it later."""

    url: str
    path: Path
    fetched_at: str          # ISO-8601 UTC
    sha256: str
    size_bytes: int
    from_cache: bool
    etag: str | None = None
    last_modified: str | None = None

    @property
    def upstream_release(self) -> str | None:
        """Best available upstream release identifier.

        Prefers Last-Modified (human-meaningful) over ETag (opaque). Returns
        None when the server offers neither, which we record honestly rather
        than substituting our own fetch date -- our fetch date is not the
        upstream release date and conflating them would misrepresent vintage.
        """
        return self.last_modified or self.etag

    def read_bytes(self) -> bytes:
        return self.path.read_bytes()

    def read_text(self, encoding: str = "utf-8") -> str:
        return self.path.read_text(encoding=encoding)

    def read_json(self) -> Any:
        return json.loads(self.read_text())


def _cache_key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]


def _sidecar_path(payload_path: Path) -> Path:
    return payload_path.with_suffix(payload_path.suffix + ".meta.json")


def _suffix_for(url: str) -> str:
    tail = url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
    for ext in (".csv.gz", ".json.gz", ".zip", ".json", ".csv", ".xlsx", ".svg", ".png"):
        if tail.endswith(ext):
            return ext
    return ".bin"


def fetch(
    url: str,
    *,
    refresh: bool = False,
    subdir: str = "raw",
    filename: str | None = None,
    headers: dict[str, str] | None = None,
    expect_json: bool = False,
) -> CachedResponse:
    """Fetch `url`, caching the raw bytes under .cache/<subdir>/.

    Raises FetchError on any non-200, on a network failure that survives
    HTTP_MAX_RETRIES, or -- when expect_json is set -- on a body that does not
    parse as JSON. The last case matters because several of our sources answer
    with an HTML error page under a 200 status when they are unhealthy, and
    that would otherwise be cached as if it were good data.
    """
    cache_dir = config.CACHE_DIR / subdir
    cache_dir.mkdir(parents=True, exist_ok=True)

    name = filename or f"{_cache_key(url)}{_suffix_for(url)}"
    payload_path = cache_dir / name
    sidecar = _sidecar_path(payload_path)

    if payload_path.exists() and sidecar.exists() and not refresh:
        meta = json.loads(sidecar.read_text("utf-8"))
        return CachedResponse(
            url=meta["url"],
            path=payload_path,
            fetched_at=meta["fetched_at"],
            sha256=meta["sha256"],
            size_bytes=meta["size_bytes"],
            from_cache=True,
            etag=meta.get("etag"),
            last_modified=meta.get("last_modified"),
        )

    request_headers = {"User-Agent": config.USER_AGENT}
    if headers:
        request_headers.update(headers)

    last_error: Exception | None = None
    for attempt in range(1, config.HTTP_MAX_RETRIES + 1):
        try:
            response = requests.get(
                url,
                headers=request_headers,
                timeout=config.HTTP_TIMEOUT_SECONDS,
                stream=True,
            )
            if response.status_code != 200:
                raise FetchError(
                    f"{url} returned HTTP {response.status_code}. "
                    f"This source must be reachable for the run to produce "
                    f"complete data; aborting rather than emitting a partial "
                    f"artifact."
                )
            body = response.content
            break
        except FetchError:
            raise
        except requests.RequestException as exc:
            last_error = exc
            if attempt == config.HTTP_MAX_RETRIES:
                raise FetchError(
                    f"{url} failed after {config.HTTP_MAX_RETRIES} attempts: "
                    f"{exc!r}"
                ) from exc
            time.sleep(config.HTTP_BACKOFF_SECONDS * attempt)
    else:  # pragma: no cover - loop always breaks or raises
        raise FetchError(f"{url} failed: {last_error!r}")

    if expect_json:
        try:
            json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            preview = body[:200].decode("utf-8", errors="replace")
            raise FetchError(
                f"{url} returned HTTP 200 but the body is not valid JSON "
                f"(first 200 bytes: {preview!r}). Refusing to cache a probable "
                f"error page as data."
            ) from exc

    payload_path.write_bytes(body)
    meta = {
        "url": url,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sha256": hashlib.sha256(body).hexdigest(),
        "size_bytes": len(body),
        "etag": response.headers.get("ETag"),
        "last_modified": response.headers.get("Last-Modified"),
    }
    sidecar.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return CachedResponse(
        url=meta["url"],
        path=payload_path,
        fetched_at=meta["fetched_at"],
        sha256=meta["sha256"],
        size_bytes=meta["size_bytes"],
        from_cache=False,
        etag=meta["etag"],
        last_modified=meta["last_modified"],
    )


def head_ok(url: str) -> bool:
    """True if `url` responds 200 to a GET of its first bytes.

    Used by revision discovery to probe for files that may not exist yet. This
    is the one place a non-200 is an expected, non-fatal answer, so it returns
    a bool instead of raising.
    """
    try:
        response = requests.get(
            url,
            headers={"User-Agent": config.USER_AGENT, "Range": "bytes=0-0"},
            timeout=30,
            stream=True,
        )
        response.close()
        return response.status_code in (200, 206)
    except requests.RequestException:
        return False


def response_to_manifest_entry(
    source_name: str,
    responses: list[CachedResponse],
    *,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Collapse one or more fetches into a single manifest record."""
    if not responses:
        raise ValueError(f"{source_name}: no responses to record")
    entry: dict[str, Any] = {
        "source": source_name,
        "fetched_at": max(r.fetched_at for r in responses),
        "upstream_release": responses[0].upstream_release,
        "files": [
            {
                "url": r.url,
                "sha256": r.sha256,
                "size_bytes": r.size_bytes,
                "fetched_at": r.fetched_at,
            }
            for r in responses
        ],
    }
    if extra:
        entry.update(extra)
    return entry


__all__ = [
    "CachedResponse",
    "FetchError",
    "fetch",
    "head_ok",
    "response_to_manifest_entry",
    "asdict",
]
