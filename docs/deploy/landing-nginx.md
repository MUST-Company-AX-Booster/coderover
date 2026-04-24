# CodeRover Landing — Deployment Notes

The file at `public/landing/index.html` is the **static marketing landing page**.
It is NOT part of the React SPA. It's plain HTML + CSS + two video files + two
font files, served as-is by whatever web server sits in front of the app.

## Routing contract

- **Public marketing traffic** (`/`, `/index.html`) → `public/landing/index.html`
- **SPA routes** (`/login`, `/dashboard`, `/chat`, ...) → React SPA (`index.html` at repo root, Vite-built)
- **API** (`/api/*`) → NestJS backend (`coderover-api`)

The landing page's CTAs link to `/login`, which falls through to the SPA.

## Dev mode

Vite serves `public/` as-is. Visit:

- `http://localhost:5173/landing/` — static landing (no React involvement)
- `http://localhost:5173/` — SPA (redirects to `/login` if unauthenticated)

## Production mode (nginx)

Ship the following `location` blocks for `coderover.<domain>`:

```nginx
server {
  server_name coderover.must.company;
  root /var/www/coderover/dist;   # the vite-built output

  # Marketing: serve the static landing at root
  location = / {
    try_files /landing/index.html =404;
    add_header Cache-Control "public, max-age=300";
  }

  # Landing static assets (video, fonts, anchors)
  location /landing/ {
    try_files $uri =404;
    # videos and fonts: long cache, they're content-addressed in prod
    location ~* \.(mp4|webm|otf|ttf|woff2)$ {
      expires 30d;
      add_header Cache-Control "public, immutable";
    }
  }

  # API → Docker container
  location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }

  # SPA fallback for all other routes
  location / {
    try_files $uri $uri/ /index.html;
  }

  listen 443 ssl;
  # ssl_* directives managed by certbot
}
```

## Production mode (Docker / Caddy alternative)

If the deploy target uses Caddy instead:

```caddyfile
coderover.must.company {
  root * /srv/coderover/dist

  # Marketing at root
  @root path /
  rewrite @root /landing/index.html

  # API → upstream
  reverse_proxy /api/* 127.0.0.1:3001

  # SPA fallback
  try_files {path} /index.html
  file_server
}
```

## Assets shipped

- `index.html` — the landing markup (998 lines, self-contained styles)
- `cr_video.mp4` (6.7 MB) — H.264 brand film, Safari/iOS fallback
- `cr_video.webm` (2.2 MB) — VP9 brand film, served first to modern browsers
- `fonts/BOKEH.otf` + `fonts/BOKEH.ttf` — self-hosted display wordmark font

## Known follow-ups (tracked separately, not blocking)

- `og:image` — no social card image yet; link previews will render without one.
  Create `public/landing/og-image.png` at 1200×630 and reference it in `<meta property="og:image">` + `<meta name="twitter:image">`.
- Video compression — `cr_video.mp4` is 6.7 MB. Once `ffmpeg` is available:
  `ffmpeg -i cr_video.mp4 -vcodec libx264 -crf 28 -vf "scale=1280:-2" cr_video-web.mp4`.
  WebM at 2.2 MB is already well-compressed.
- `canonical` URL and OG `url` are set to `coderover.must.company`. Update both
  if the final production domain changes.
