"""Per-source ingestion modules.

Each module exposes `ingest(registry, aliases, *, refresh, manifest) -> None`
and is responsible for writing its own artifacts into /data and recording its
provenance into the manifest. No module here may contain a hardcoded endpoint
or indicator code -- those live in etl/config.py.
"""
