package com.lyrics.translator

import android.graphics.Color
import android.os.Handler
import android.os.Looper

object SpotifyPlaybackManager {
    interface PlaybackListener {
        fun onTrackChanged(title: String, artist: String)
        fun onPlaybackStateChanged(isPlaying: Boolean, positionMs: Long, durationMs: Long, playbackSpeed: Float)
        fun onBackgroundColorChanged(color: Int)
    }

    private val listeners = mutableListOf<PlaybackListener>()
    var currentTrackId: String = ""
        private set
    var currentTitle: String = ""
        private set
    var currentArtist: String = ""
        private set
    var isPlaying: Boolean = false
        private set
    var lastPositionMs: Long = 0L
        private set
    var durationMs: Long = 0L
        private set
    var playbackSpeed: Float = 1.0f
        private set
    var lastPositionUpdateTimeMs: Long = 0L
        private set
    var currentBackgroundColor: Int = Color.parseColor("#2E2514") // Spotify dark warm gold fallback
        private set

    private val mainHandler = Handler(Looper.getMainLooper())

    fun registerListener(listener: PlaybackListener) {
        synchronized(listeners) {
            listeners.add(listener)
        }
        // Fire current state on main thread, but only if there is already a known track
        if (currentTitle.isNotEmpty()) {
            mainHandler.post {
                listener.onTrackChanged(currentTitle, currentArtist)
                listener.onPlaybackStateChanged(isPlaying, lastPositionMs, durationMs, playbackSpeed)
                listener.onBackgroundColorChanged(currentBackgroundColor)
            }
        }
    }

    fun unregisterListener(listener: PlaybackListener) {
        synchronized(listeners) {
            listeners.remove(listener)
        }
    }

    fun updateTrack(title: String, artist: String) {
        if (currentTitle != title || currentArtist != artist) {
            currentTitle = title
            currentArtist = artist
            mainHandler.post {
                synchronized(listeners) {
                    for (l in listeners) l.onTrackChanged(title, artist)
                }
            }
        }
    }

    fun updateTrackId(trackId: String) {
        currentTrackId = trackId
    }

    fun updatePlaybackState(playing: Boolean, pos: Long, dur: Long, speed: Float, updateTime: Long) {
        isPlaying = playing
        lastPositionMs = pos
        durationMs = dur
        playbackSpeed = speed
        lastPositionUpdateTimeMs = updateTime
        mainHandler.post {
            synchronized(listeners) {
                for (l in listeners) l.onPlaybackStateChanged(playing, pos, dur, speed)
            }
        }
    }

    fun updateBackgroundColor(color: Int) {
        if (currentBackgroundColor != color) {
            currentBackgroundColor = color
            mainHandler.post {
                synchronized(listeners) {
                    for (l in listeners) l.onBackgroundColorChanged(color)
                }
            }
        }
    }
}
