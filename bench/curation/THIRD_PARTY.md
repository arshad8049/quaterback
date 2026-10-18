# Third-party code in the curation trees

The `reference/` and `incorrect/` trees under `bench/curation/<ID>/` are modified copies of
whole source files from the pinned upstream repositories below. They are used only to qualify
hidden suites (QB-27/QB-30) and are never shipped with Quarterback. Each upstream's license
applies to its files and is reproduced in `licenses/`.

| Repository | Pinned | License | Notice |
|---|---|---|---|
| [fastify/avvio](https://github.com/fastify/avvio) | v9.3.0 | MIT | `licenses/avvio.LICENSE` |
| [fastify/fast-json-stringify](https://github.com/fastify/fast-json-stringify) | v7.0.1 | MIT | `licenses/fast-json-stringify.LICENSE` |
| [fastify/light-my-request](https://github.com/fastify/light-my-request) | v6.6.0 | BSD-3-Clause | `licenses/light-my-request.LICENSE` |
| [fastify/process-warning](https://github.com/fastify/process-warning) | v5.1.0 | MIT | `licenses/process-warning.LICENSE` |
| [fastify/fastify-plugin](https://github.com/fastify/fastify-plugin) | v6.0.0 | MIT | `licenses/fastify-plugin.LICENSE` |

The pinned lockfiles in `bench/repos/` are generated metadata (package names, versions,
registry URLs and integrity hashes), not upstream code.
