# MiX 1.5

Stremio stream addon that uses Gram Cinema's authenticated TG Archive backend and returns curated direct streams.

## Run locally

```bash
cd Grama
npm install
node index.js
```

Manifest:

```text
http://127.0.0.1:7021/manifest.json
```

## Notes

- Uses the current Gram Cinema bearer token as the default auth token.
- You can override it with `GRAMA_BEARER_TOKEN`.
- Main manifest: `http://127.0.0.1:7021/manifest.json`
- Minimal test manifest: `http://127.0.0.1:7021/simple/manifest.json`
