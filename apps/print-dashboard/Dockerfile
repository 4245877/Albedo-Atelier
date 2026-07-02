FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY styles.css /usr/share/nginx/html/styles.css
COPY app.js /usr/share/nginx/html/app.js
COPY camera-webrtc.js /usr/share/nginx/html/camera-webrtc.js
COPY video-rtc.js /usr/share/nginx/html/video-rtc.js

EXPOSE 8080
