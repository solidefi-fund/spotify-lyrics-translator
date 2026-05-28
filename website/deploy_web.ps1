gcloud run deploy lyrics-translator-web --source . --region us-central1 --allow-unauthenticated --platform managed --port 8080 --quiet
gcloud beta run domain-mappings create --service lyrics-translator-web --domain lyricstranslate.solidefi.co --region us-central1 --quiet
