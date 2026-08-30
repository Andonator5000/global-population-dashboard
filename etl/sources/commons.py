"""Shared Wikimedia Commons helpers.

Several stages (currency images, inventions, flora/fauna, cuisine) hotlink a
Commons image and must ship its licence and author alongside -- CC licences
make attribution a reuse CONDITION, not a courtesy. This module is the one
place that talks to the Commons API so the batching, the missing-file
handling, and the URL scheme stay identical everywhere.

Images are hotlinked via Special:FilePath at a Commons-bucketed width;
upload.wikimedia.org answers HTTP 400 to arbitrary widths since 2026.
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from .. import config
from ..fetch import CachedResponse, fetch

_BATCH = 20  # titles per API request, kept under URL-length limits
_TAG = re.compile(r"<[^>]+>")

#: Filename marker in Wikidata image URLs and thumb URLs.
FILEPATH_MARKER = "Special:FilePath/"


def strip_html(text: str) -> str:
    return _TAG.sub("", text).strip()


def filename_from_special_path(image_url: str) -> str | None:
    """Commons filename out of a Wikidata Special:FilePath image URL."""
    index = image_url.find(FILEPATH_MARKER)
    if index == -1:
        return None
    return urllib.parse.unquote(image_url[index + len(FILEPATH_MARKER):])


def filename_from_thumb_url(src: str) -> str | None:
    """Commons filename out of an upload.wikimedia.org thumbnail URL.

    Thumb URLs look like
    //upload.wikimedia.org/wikipedia/commons/thumb/9/9b/Name.jpg/250px-Name.jpg
    -- the ORIGINAL name is the second-to-last path segment.
    """
    match = re.search(r"/commons/thumb/[0-9a-f]/[0-9a-f]{2}/([^/]+)/", src)
    if not match:
        return None
    return urllib.parse.unquote(match.group(1)).replace("_", " ")


def image_url_for(filename: str, width: int = config.COMMONS_IMAGE_WIDTH) -> str:
    quoted = urllib.parse.quote(filename)
    return (
        f"https://commons.wikimedia.org/wiki/Special:FilePath/"
        f"{quoted}?width={width}"
    )


def file_page_for(filename: str) -> str:
    return f"https://commons.wikimedia.org/wiki/File:{urllib.parse.quote(filename)}"


def fetch_metadata(
    filenames: list[str],
    *,
    refresh: bool,
    subdir: str,
) -> tuple[dict[str, dict[str, str | None]], list[CachedResponse]]:
    """{filename: {license, author, description, objectName, categories,
    width, height, mime}} for files that exist on Commons.

    A file absent from the result was renamed or deleted under whoever
    referenced it; callers must DROP it rather than hotlink a 404. The
    description, object name and categories exist so a caller can verify
    the file is OF the thing it is being attached to (2026-08-29: a
    national-animal card must not carry a photo of some other species).
    """
    out: dict[str, dict[str, str | None]] = {}
    responses: list[CachedResponse] = []
    ordered = sorted(set(filenames))
    for start in range(0, len(ordered), _BATCH):
        batch = ordered[start:start + _BATCH]
        titles = "|".join(f"File:{name}" for name in batch)
        url = (
            f"{config.COMMONS_API_URL}?action=query&format=json"
            f"&prop=imageinfo&iiprop=extmetadata%7Csize%7Cmime&redirects=1"
            f"&titles={urllib.parse.quote(titles)}"
        )
        # Cache by URL hash, never by batch position: a positional name like
        # commons-meta-003.json silently serves a STALE response when the
        # file set (and so the batch contents) changes between runs.
        response = fetch(url, refresh=refresh, subdir=subdir, expect_json=True)
        responses.append(response)
        pages = response.read_json().get("query", {}).get("pages", {})
        for page in pages.values():
            title = (page.get("title") or "").removeprefix("File:")
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata") or {}
            if not title or "missing" in page:
                continue
            out[title] = {
                "license": (meta.get("LicenseShortName") or {}).get("value"),
                "author": strip_html(
                    (meta.get("Artist") or {}).get("value") or ""
                ) or None,
                "description": strip_html(
                    (meta.get("ImageDescription") or {}).get("value") or ""
                ) or None,
                "objectName": strip_html(
                    (meta.get("ObjectName") or {}).get("value") or ""
                ) or None,
                "categories": (meta.get("Categories") or {}).get("value"),
                "width": info.get("width"),
                "height": info.get("height"),
                "mime": info.get("mime"),
            }
    return out, responses


def metadata_text(filename: str, meta: dict[str, dict[str, Any]]) -> str:
    """Everything Commons says about a file, lowercased, for keyword checks."""
    record = meta.get(filename) or {}
    return " ".join(
        str(part) for part in (
            filename, record.get("objectName"), record.get("description"),
            record.get("categories"),
        ) if part
    ).lower()


def image_record(
    filename: str,
    metadata: dict[str, dict[str, Any]],
) -> dict[str, str | None] | None:
    """The standard hotlink+attribution payload, or None if not on Commons."""
    if filename not in metadata:
        return None
    return {
        "imageUrl": image_url_for(filename),
        "commonsPage": file_page_for(filename),
        "license": metadata[filename]["license"],
        "author": metadata[filename]["author"],
        "source": "Wikimedia Commons",
    }


__all__ = [
    "FILEPATH_MARKER",
    "fetch_metadata",
    "file_page_for",
    "filename_from_special_path",
    "filename_from_thumb_url",
    "image_record",
    "image_url_for",
    "metadata_text",
    "strip_html",
]
