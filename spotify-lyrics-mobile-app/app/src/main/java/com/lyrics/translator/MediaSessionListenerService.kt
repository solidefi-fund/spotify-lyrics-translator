package com.lyrics.translator

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Build
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.util.Log

class MediaSessionListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "MediaSessionListener"
        private const val SPOTIFY_PACKAGE = "com.spotify.music"
        private const val ACTION_METADATA = "com.spotify.music.metadatachanged"
    }

    private lateinit var mediaSessionManager: MediaSessionManager
    private var activeController: MediaController? = null

    // Listen to Spotify's own broadcast for track ID — more reliable than MediaMetadata
    private val spotifyBroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_METADATA) {
                val id = intent.getStringExtra("id") ?: return
                if (id.isNotEmpty()) {
                    Log.d(TAG, "Spotify broadcast track ID: $id")
                    SpotifyPlaybackManager.updateTrackId(id)
                }
            }
        }
    }

    private val sessionListener = MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
        Log.d(TAG, "Active sessions changed: ${controllers?.size ?: 0} sessions")
        findAndHookSpotifySession(controllers)
    }

    private val controllerCallback = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) {
            super.onMetadataChanged(metadata)
            updateMetadata(metadata)
        }

        override fun onPlaybackStateChanged(state: PlaybackState?) {
            super.onPlaybackStateChanged(state)
            if (state != null) {
                val isPlaying = state.state == PlaybackState.STATE_PLAYING
                val position = state.position
                val speed = state.playbackSpeed
                val duration = activeController?.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
                Log.d(TAG, "Playback state changed: isPlaying=$isPlaying position=$position duration=$duration")
                SpotifyPlaybackManager.updatePlaybackState(
                    isPlaying,
                    position,
                    duration,
                    speed,
                    SystemClock.elapsedRealtime()
                )
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        mediaSessionManager = getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager

        // Register for Spotify's broadcast (gives us the Spotify track ID directly)
        val filter = IntentFilter(ACTION_METADATA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(spotifyBroadcastReceiver, filter, RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(spotifyBroadcastReceiver, filter)
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.d(TAG, "Notification listener connected")
        try {
            val componentName = ComponentName(this, MediaSessionListenerService::class.java)
            mediaSessionManager.addOnActiveSessionsChangedListener(sessionListener, componentName)

            // Look up initial sessions
            val controllers = mediaSessionManager.getActiveSessions(componentName)
            findAndHookSpotifySession(controllers)
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to register active session listener", e)
        }
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.d(TAG, "Notification listener disconnected")
        cleanup()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "com.lyrics.translator.REFRESH") {
            Log.d(TAG, "Refresh requested via onStartCommand")
            try {
                val componentName = ComponentName(this, MediaSessionListenerService::class.java)
                val controllers = mediaSessionManager.getActiveSessions(componentName)
                findAndHookSpotifySession(controllers)
            } catch (e: SecurityException) {
                Log.e(TAG, "Failed to get active sessions on refresh", e)
            }
        }
        return super.onStartCommand(intent, flags, startId)
    }

    private fun findAndHookSpotifySession(controllers: List<MediaController>?) {
        if (controllers == null) return

        var spotifyController: MediaController? = null
        for (controller in controllers) {
            if (controller.packageName == SPOTIFY_PACKAGE) {
                spotifyController = controller
                break
            }
        }

        if (spotifyController != null) {
            if (activeController?.sessionToken != spotifyController.sessionToken) {
                activeController?.unregisterCallback(controllerCallback)
                activeController = spotifyController
                activeController?.registerCallback(controllerCallback)
                Log.d(TAG, "Hooked new Spotify MediaController session")

                // Fetch initial states
                val metadata = activeController?.metadata
                updateMetadata(metadata)

                val state = activeController?.playbackState
                if (state != null) {
                    val isPlaying = state.state == PlaybackState.STATE_PLAYING
                    val position = state.position
                    val speed = state.playbackSpeed
                    val duration = activeController?.metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
                    SpotifyPlaybackManager.updatePlaybackState(
                        isPlaying,
                        position,
                        duration,
                        speed,
                        SystemClock.elapsedRealtime()
                    )
                }
            }
        } else {
            // No Spotify session active
            if (activeController != null) {
                Log.d(TAG, "Spotify session lost")
                cleanup()
            }
        }
    }

    private fun updateMetadata(metadata: MediaMetadata?) {
        if (metadata == null) return

        val title = metadata.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""
        val artist = metadata.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: ""
        Log.d(TAG, "Track updated: $title - $artist")
        SpotifyPlaybackManager.updateTrack(title, artist)

        // Try to extract track ID from MediaMetadata URI fields (Spotify puts it here on some versions)
        val mediaUri = metadata.getString(MediaMetadata.METADATA_KEY_MEDIA_URI) ?: ""
        val mediaId  = metadata.getString(MediaMetadata.METADATA_KEY_MEDIA_ID) ?: ""
        val trackId = when {
            mediaUri.startsWith("spotify:track:") -> mediaUri.removePrefix("spotify:track:")
            mediaId.startsWith("spotify:track:")  -> mediaId.removePrefix("spotify:track:")
            else -> ""
        }
        if (trackId.isNotEmpty()) {
            Log.d(TAG, "Extracted track ID from MediaMetadata: $trackId")
            SpotifyPlaybackManager.updateTrackId(trackId)
        }

        // Extract album art dominant color
        val bitmap = metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: metadata.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: metadata.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)

        if (bitmap != null) {
            try {
                val singlePixel = android.graphics.Bitmap.createScaledBitmap(bitmap, 1, 1, true)
                val pixelColor = singlePixel.getPixel(0, 0)
                singlePixel.recycle()

                val hsv = FloatArray(3)
                android.graphics.Color.colorToHSV(pixelColor, hsv)
                hsv[2] = (hsv[2] * 0.35f).coerceAtLeast(0.12f)
                hsv[1] = (hsv[1] * 1.1f).coerceAtMost(1.0f)
                val darkBgColor = android.graphics.Color.HSVToColor(hsv)

                SpotifyPlaybackManager.updateBackgroundColor(darkBgColor)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to extract dominant color from album art", e)
            }
        } else {
            SpotifyPlaybackManager.updateBackgroundColor(android.graphics.Color.parseColor("#2E2514"))
        }
    }

    private fun cleanup() {
        activeController?.unregisterCallback(controllerCallback)
        activeController = null
        try {
            mediaSessionManager.removeOnActiveSessionsChangedListener(sessionListener)
        } catch (e: Exception) {
            // Ignore
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(spotifyBroadcastReceiver)
        } catch (e: Exception) {
            // Ignore if not registered
        }
        cleanup()
    }
}
