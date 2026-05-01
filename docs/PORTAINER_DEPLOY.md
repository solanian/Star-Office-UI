# Portainer Deployment

This deployment runs Star Office UI in Docker and publishes it on the LAN through host port `19000`.

Portainer server: `https://100.75.202.58:9443`

Target endpoint: `Oracle Server` (`tcp://100.75.230.136:9001`)

Current stack: `star-office-ui` (Portainer stack ID `17`)

## Files

- `Dockerfile`: builds the `star-office-ui:latest` image.
- `docker-compose.yml`: local Docker Compose build/run file.
- `deploy/portainer-stack.yml`: Portainer Stack file. It expects `star-office-ui:latest` to already exist on the Docker host.

## Required Stack Variables

Set these in Portainer or `.env`:

```env
STAR_OFFICE_UI_HOST_PORT=19000
STAR_OFFICE_ENV=production
FLASK_SECRET_KEY=<long random secret, at least 24 chars>
ASSET_DRAWER_PASS=<strong drawer password, at least 8 chars>
OFFICE_JOIN_KEY=ocj_example_team_01
OFFICE_AGENT_NAME=Star
```

## Deploy

Build the image on the Docker host:

```bash
docker build -t star-office-ui:latest .
```

Then create or update a Portainer Stack using `deploy/portainer-stack.yml`.

The app will be available at:

```text
http://100.75.230.136:19000
```
