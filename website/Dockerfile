FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
# Cloud Run expects the container to listen on the port defined by the PORT environment variable, which defaults to 8080.
# But we can override it via gcloud, or just configure nginx to use 8080.
RUN sed -i 's/listen  *80;/listen 8080;/g' /etc/nginx/conf.d/default.conf
EXPOSE 8080
