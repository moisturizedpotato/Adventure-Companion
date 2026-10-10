# Wayfarer

A client-side outing companion prototype built with React, TypeScript, and Vite, with a small Node.js server for nearby-place searches. There is no account, hosted diary model, analytics, external font, or database. Place discovery is an explicit exception to fully local operation: after the user chooses GPS, manually selected map-point, or typed-area search, approximate coordinates and interest terms are sent to the application server, which constructs a fixed-scope query to OpenStreetMap Overpass. Typed-area search also sends the entered area text directly to OpenStreetMap Nominatim to resolve an approximate centre.

## Run locally

```sh
npm install
npm run dev
```

To run the focused tests, run `npm test`. To make a production build, run `npm run build`.

### Production deployment

The repository has no preconfigured deployment target or serverless-host configuration. Nearby search needs the same-origin `/api/nearby` endpoint as well as the static app; deploying only the Vite output to a static host (including `vite preview`) will not provide that endpoint.

The included Node.js production server is the smallest supported deployment path. Use a Node.js 20+ host with outbound HTTPS access to the allowlisted OpenStreetMap Overpass services, deploy the repository including the built `dist/` directory, and run:

```sh
npm run build
npm start
```

The server listens on `0.0.0.0` and uses the platform-provided `PORT` environment variable, or port 3000 when unset. Set `HOST` only if the deployment environment requires a different bind address. Vite development uses the same endpoint handler through middleware; Vite preview is only a static preview and is not the production server.

### Overpass client identification

Before using nearby search, configure `OVERPASS_USER_AGENT` in the environment of the Node.js server (including the Vite process during local development). Set it to a truthful application identifier that includes the real project URL or contact information, for example the form `Wayfarer/<version> (+<your real project URL or contact>)`; replace the placeholders with actual project details. Do not use a fabricated URL or contact address. Keep this configuration on the server and restart the process after changing it.

If `OVERPASS_USER_AGENT` is missing or invalid, nearby search returns a clear `configuration_required` error without contacting an Overpass instance. The same actionable error is returned if an instance indicates that the configured identification needs attention. Search can still continue through the app's saved/manual-place fallback.

## What works

- Onboarding saves the user's name, interests, outing preferences, and optional area in browser `localStorage`.
- An outing suggestion requires a search area, timing, available hours, interests, and either a place the user manually added and confirmed or a named OpenStreetMap result they choose after an explicit nearby search. GPS searches use the device's current position; typed-area searches geocode the locality the user entered; manual map-point search accepts coordinates or a copied OpenStreetMap Share link. Typed-area and manual map-point searches do not request device location. Nearby searches cover 3 km around the selected point. Coordinates are rounded to about 100 m before being sent to the application server and are not saved by this app. Search categories are selected and ranked around the user's interests, including adventure activities; users can request another search with a more specific activity such as kayaking or climbing. OpenStreetMap place names, relevant tags, and record links are surfaced with attribution. The application server sends requests sequentially to a fixed allowlist of Overpass instances, with bounded timeouts/retries and clear errors if the service is unavailable. Map data may be incomplete or stale: the app does not verify visitor access, opening times, routes, or safety.
- Friend preferences can be added without an account and are included when ranking saved places and explaining a suggestion.
- Typed session notes and user-kept moments are saved locally as the outing proceeds. The app can show a camera preview after the user explicitly chooses to enable it. It does not retain raw images by default and has no vision model; a user can choose an image for their own reference and describe it in text.
- Diary entries can be composed by the local fallback or generated with Gemma 2 2B in the browser. Gemma is optional: the user must accept its terms and download its model/runtime assets (about 1.49 GB of model files, plus runtime assets). It requires WebGPU with `shader-f16` and approximately 1.9 GB of GPU memory. The prompt contains extracted, compact fact cues rather than the user's original notes; output is checked against source wording and grounded in supplied facts. Prompt and sampling settings encourage varied first-person forms; this is inference-time prompting, not fine-tuning the model weights. Generation and fallback preview are both saved as the diary entry. If Gemma is unavailable, the clearly labelled local composition fallback remains usable. Reading, exporting, and deleting local diary data are available.

## Privacy and model boundaries

The app stores profile data, saved places, draft session notes, and diary entries in this browser's `localStorage`. This app does **not encrypt** that data. Browser profile access and site-data clearing affect its availability. JSON export and delete-all controls are in Settings.

Nothing is sent for place discovery until the user taps a search button. GPS search requests browser permission. GPS and manual map-point searches send coordinates rounded to about 100 m, along with interest/refinement text, to this application's nearby-search server. Typed-area search sends the entered place text directly to `nominatim.openstreetmap.org` to resolve an approximate centre, then sends rounded coordinates and interest/refinement text to the application server. The application server constructs the fixed 3 km Overpass query and sequentially sends it to a fixed allowlist of public Overpass instances. The server necessarily receives the location query and can observe ordinary request metadata; the server code does not persist search coordinates or log request bodies. The Overpass service that answers receives the query and the application server's network metadata. The hosting provider may have its own infrastructure logging/retention policies, which this application does not control. Search results are shown with source links and `© OpenStreetMap contributors` attribution; the data is available under the [Open Database License](https://www.openstreetmap.org/copyright). Coordinates are not persisted in browser storage or diary entries. Nearby search requires internet access and a deployment that runs the included Node.js API server; it does not work offline. Users who do not wish to share location or area text can add a place they have personally confirmed.

Gemma 2 2B is an optional local language model. Before setup, the app checks secure context, WebGPU, and `shader-f16`; actual inference additionally depends on GPU memory and browser/runtime compatibility. Initial setup downloads roughly 1.49 GB of model files from Hugging Face plus the compiled runtime from a version-pinned jsDelivr URL, and requires accepting the [Gemma Terms of Use](https://ai.google.dev/gemma/terms). Those hosts receive ordinary network metadata during setup; after setup, diary prompts and generation run locally and diary content is not sent to an inference service. Model files are cached in browser storage and may be evicted. The user can remove them in Settings. On unsupported devices, the local composition fallback remains available. Prompt and sampling parameters are tuned for variety and low source-phrase overlap; the model weights are not fine-tuned.

The application does not use Web Speech recognition, since browser implementations may send audio to a service. The microphone is not activated. If the browser reports an installed speech-synthesis voice as local, the app can use it to read a typed note; otherwise that control is unavailable and typed notes remain usable. No local speech-recognition or vision model is configured.

The camera requires a browser that exposes `getUserMedia`, normally on HTTPS or `localhost`, and an explicit user permission. The stream is shown only in the current page, stops when the outing ends, and can be paused or stopped at any time. A captured or selected image stays in tab memory; it is not put in the diary or browser storage.

The layout and web APIs target modern browsers. The app was built and smoke-tested in the integrated Chromium browser; other browsers may differ in camera, service-worker, geolocation, and locally installed speech-voice support. Geolocation requires a secure context (HTTPS or localhost) and explicit browser permission. The Settings screen reports detectable capabilities. Offline startup and local diaries work after the service worker has cached the app shell; nearby search requires a network connection.
