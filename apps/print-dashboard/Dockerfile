FROM nginx:1.27-alpine

# nginx.conf is an envsubst template: the image entrypoint renders it to
# /etc/nginx/conf.d/default.conf at container start, substituting
# ${ORCHESTRATOR_API_TOKEN} from the environment (see compose.yml).
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
# Dashboard ES modules: entry (app.js) + shared modules + render/ folder.
COPY app.js api.js poll.js util.js nav.js cameraPlayers.js actions.js theme.js /usr/share/nginx/html/
COPY render /usr/share/nginx/html/render
COPY assets /usr/share/nginx/html/assets
COPY camera-webrtc.js /usr/share/nginx/html/camera-webrtc.js
COPY video-rtc.js /usr/share/nginx/html/video-rtc.js

EXPOSE 8080
