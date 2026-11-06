# Ready drive snapshots

- `GET /v1/volumes` (also `?metadata=1`) is metadata-only. `index.recordCount` includes directories; the panel file count does not.
- `GET /v1/files?serial=...&uuid=...&revision=...&offset=0&limit=10000` reads an existing snapshot, never scans a disk. A changed revision returns 409; the client publishes only after all pages are received. Legacy full export is explicit `?files=1`.
- Complete snapshots do not expire on a timer or free-space fluctuations. Collect ticks retain volume object identity and cannot overlap. Errors are not automatically retried.
- Snapshots persist as gzip JSON at `SKLAD_AGENT_SNAPSHOT`, default `data/drive-agent-snapshot.json.gz`. A corrupt existing snapshot fails closed (no automatic full scan).
- An operator can explicitly request `POST /v1/rescan?serial=...&uuid=...`; busy/excluded disks are refused. This is a full refresh, not yet a safe incremental USN refresh. The current fsutil parser cannot resolve journal FRNs to full paths, so automatic USN application is deliberately not enabled.
- `data/drive-agent-disabled.json`, e.g. `{"letters":["Z"]}`, excludes that drive from published connected volumes and from all indexing; the panel retains its prior offline catalog. This does not unmount or modify any disk.
- The panel keeps one parsed local catalog, keyed by file stat, shares file arrays across metadata reconciliations, caches summary counts, and does not rewrite the large catalog for metadata-only ticks. Search uses the ready local index without waiting for an agent poll. Small changed volumes are persisted in a stamped `drives.json.overlay`, without rewriting C/S; a large new snapshot replaces the atomic base and invalidates any old overlay. Search limit is capped at 1000.
- Initial `restored:<recordCount>` revisions are reserved for importing the exact panel catalog into the agent. The panel can reuse that tree once without downloading it back; subsequent successful scans use UUID revisions.

Runtime snapshots, exclusions and host configuration must not be committed.
