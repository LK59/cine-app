# Quick start

```bash
mkdir cine-app && cd cine-app
curl -o docker-compose.yml https://raw.githubusercontent.com/LK59/cine-app/main/docker-compose.example.yml
docker compose up -d
```

Open `http://<server>:3000` and follow the setup assistant: an administrator account, then
Jellyfin, TMDB and Radarr or Sonarr. Everything else is set later in the app. No `.env` needed.

The complete guide — the compose file line by line, the reverse proxy, each screen of the
assistant, the settings, updates and backups — is **[DEPLOYMENT.md](DEPLOYMENT.md)**. Every
variable is in **[ENV.md](ENV.md)**.
