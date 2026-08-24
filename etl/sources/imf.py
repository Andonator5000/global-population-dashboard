"""IMF World Economic Outlook via the DataMapper API: public debt and GDP.

Two series, both ISO3-keyed and keyless:

    GGXWDG_NGDP  general government gross debt, % of GDP
    NGDPD        GDP, current prices, US$ billions

The API carries ~5 years of PROJECTIONS past the current year. They are kept
and flagged with `projectionsFrom`: the app interpolates between annual
values to show a continuously-moving debt figure, exactly the discipline the
population counter established -- and both ends of that interpolation being
projections must be sayable on the page, not discoverable in a footnote.

The API is not CORS-enabled (verified), so this is strictly a build-time
source; the app never fetches imf.org at render time.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch


def _series(
    payload: Any, code: str, registry: dict[str, Entity]
) -> dict[str, dict[int, float]]:
    values = payload.get("values", {}).get(code)
    if not isinstance(values, dict):
        raise FetchError(
            f"IMF DataMapper {code} response carries no values object."
        )
    out: dict[str, dict[int, float]] = {}
    for key, years in values.items():
        iso3 = key.upper()
        if iso3 in config.IMF_AGGREGATE_KEYS or iso3 not in registry:
            continue
        series: dict[int, float] = {}
        for year_text, value in years.items():
            try:
                series[int(year_text)] = float(value)
            except (TypeError, ValueError):
                continue
        if series:
            out[iso3] = series
    if len(out) < 150:
        raise FetchError(
            f"IMF {code} resolved to only {len(out)} registry entities; "
            f"expected ~190. The API shape may have changed."
        )
    return out


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "economy"
    out_dir.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []
    payloads: dict[str, Any] = {}
    for code in (config.IMF_DEBT_PCT_GDP, config.IMF_GDP_USD_BILLIONS):
        # imf.org's WAF rejects UNFAMILIAR user agents (403) while accepting
        # stock client strings -- verified: our project UA and even a browser
        # UA fail, but requests' own default passes. So this one source uses
        # the library's genuine UA rather than the descriptive project one.
        import requests as _requests

        response = fetch(
            config.IMF_DATAMAPPER_TEMPLATE.format(code=code),
            refresh=refresh,
            subdir="imf",
            filename=f"{code}.json",
            expect_json=True,
            headers={"User-Agent": f"python-requests/{_requests.__version__}"},
        )
        responses.append(response)
        payloads[code] = response.read_json()

    debt = _series(payloads[config.IMF_DEBT_PCT_GDP], config.IMF_DEBT_PCT_GDP, registry)
    gdp = _series(payloads[config.IMF_GDP_USD_BILLIONS], config.IMF_GDP_USD_BILLIONS, registry)

    # WEO's estimate/projection boundary is not exposed per-country by this
    # endpoint; the current calendar year is the honest, conservative cut.
    projections_from = datetime.now(timezone.utc).year

    entities: dict[str, Any] = {}
    for iso3 in sorted(set(debt) | set(gdp)):
        record: dict[str, Any] = {}
        if iso3 in debt:
            years = sorted(debt[iso3])
            record["debtPctGdp"] = {
                "years": years,
                "values": [debt[iso3][y] for y in years],
            }
        if iso3 in gdp:
            years = sorted(gdp[iso3])
            record["gdpUsdBillions"] = {
                "years": years,
                "values": [gdp[iso3][y] for y in years],
            }
        entities[iso3] = record

    document = {
        "source": "imf_weo",
        "projectionsFrom": projections_from,
        "note": (
            "Annual figures; years from projectionsFrom onward are IMF "
            "medium-term projections, not observations. Debt in US$ is "
            "DERIVED (debt %GDP × nominal GDP) and inherits both series' "
            "uncertainty."
        ),
        "entities": entities,
    }
    (out_dir / "debt.json").write_text(
        json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "imf_weo",
        title="IMF World Economic Outlook (DataMapper API)",
        url=config.IMF_DATAMAPPER_TEMPLATE.format(code=config.IMF_DEBT_PCT_GDP),
        licence="IMF terms; cited with attribution",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=responses[0].upstream_release,
        vintage=f"annual series incl. projections; boundary {projections_from}",
        citation="IMF World Economic Outlook, via the DataMapper API",
        notes=(
            f"{len(debt)} entities with debt (% of GDP), {len(gdp)} with "
            f"nominal GDP. Not CORS-enabled, so build-time only."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "economy/debt.json",
        description=(
            "General government gross debt (% of GDP) and nominal GDP annual "
            "series per entity, IMF WEO, including projections."
        ),
        sources=["imf_weo"], entity_count=len(entities),
    )
    print(f"    IMF WEO: {len(debt)} debt series, {len(gdp)} GDP series")


__all__ = ["ingest"]
