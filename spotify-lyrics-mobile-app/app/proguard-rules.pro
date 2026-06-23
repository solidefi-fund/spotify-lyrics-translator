# Proguard rules for Lyrics Overlay app
# Add your optimization/obfuscation rules here.

# Keep generic signatures for Gson TypeToken
-keepattributes Signature
-keepattributes *Annotation*

# Keep Gson TypeToken subclasses
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken

# Keep LyricLine
-keep class com.lyrics.translator.LyricLine { *; }
