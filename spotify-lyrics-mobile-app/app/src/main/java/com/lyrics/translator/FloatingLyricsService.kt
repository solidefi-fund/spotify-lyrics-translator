package com.lyrics.translator

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.view.*
import android.widget.*
import androidx.core.app.NotificationCompat
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import kotlinx.coroutines.tasks.await

import androidx.annotation.Keep

@Keep
data class LyricLine(
    val startTimeMs: Long,
    val words: String,
    var translation: String? = null
)

class FloatingLyricsService : Service(), SpotifyPlaybackManager.PlaybackListener {

    companion object {
        private const val TAG = "FloatingLyricsService"
        private const val CHANNEL_ID = "floating_lyrics_channel"
        private const val NOTIFICATION_ID = 2001
        
        var isRunning = false
            private set
    }

    private lateinit var windowManager: WindowManager
    private lateinit var floatingView: View
    private lateinit var params: WindowManager.LayoutParams

    // Views
    private lateinit var layoutMain: LinearLayout
    private lateinit var layoutBubble: LinearLayout
    private lateinit var layoutBubbleText: LinearLayout
    private lateinit var layoutHeader: RelativeLayout
    private lateinit var lvLyrics: ListView
    private lateinit var tvStatus: TextView
    private lateinit var tvBubbleLyric: TextView
    private lateinit var tvBubbleTranslation: TextView
    private lateinit var btnShare: ImageButton
    private lateinit var btnEdit: ImageButton
    private lateinit var btnMinimize: ImageButton
    private lateinit var btnExpand: ImageButton
    private lateinit var btnClose: ImageButton

    // State
    private var isMinimized = false
    private var currentActiveIndex = -1
    private var currentLyrics = listOf<LyricLine>()
    private var currentTrackName = ""
    private var currentArtistName = ""

    // Background color state
    private var currentBgColor: Int = android.graphics.Color.parseColor("#3D2E0F")

    private val serviceScope = CoroutineScope(Dispatchers.Main + Job())
    private var syncJob: Job? = null
    private var lyricsFetchJob: Job? = null
    private lateinit var adapter: LyricsAdapter
    
    private val lyricsUpdateReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "com.lyrics.translator.LYRICS_UPDATED") {
                Log.d(TAG, "Received LYRICS_UPDATED broadcast. Reloading lyrics...")
                if (currentTrackName.isNotEmpty() && currentArtistName.isNotEmpty()) {
                    onTrackChanged(currentTrackName, currentArtistName)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, createNotification("Waiting for Spotify..."))

        setupFloatingView()
        SpotifyPlaybackManager.registerListener(this)

        // Wake up the NotificationListenerService and force it to check current media sessions
        // because it might have been asleep or missed the last broadcast.
        val refreshIntent = Intent(this, MediaSessionListenerService::class.java).apply {
            action = "com.lyrics.translator.REFRESH"
        }
        try {
            startService(refreshIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send refresh intent to MediaSessionListenerService", e)
        }
        
        val filter = android.content.IntentFilter("com.lyrics.translator.LYRICS_UPDATED")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(lyricsUpdateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(lyricsUpdateReceiver, filter)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_NOT_STICKY
    }

    private fun setupFloatingView() {
        floatingView = LayoutInflater.from(this).inflate(R.layout.floating_lyrics_layout, null)

        layoutMain = floatingView.findViewById(R.id.layoutMain)
        layoutBubble = floatingView.findViewById(R.id.layoutBubble)
        layoutBubbleText = floatingView.findViewById(R.id.layoutBubbleText)
        layoutHeader = floatingView.findViewById(R.id.layoutHeader)
        lvLyrics = floatingView.findViewById(R.id.lvLyrics)
        tvStatus = floatingView.findViewById(R.id.tvStatus)
        tvBubbleLyric = floatingView.findViewById(R.id.tvBubbleLyric)
        tvBubbleTranslation = floatingView.findViewById(R.id.tvBubbleTranslation)
        btnShare = floatingView.findViewById(R.id.btnShare)
        btnEdit = floatingView.findViewById(R.id.btnEdit)
        btnMinimize = floatingView.findViewById(R.id.btnMinimize)
        btnExpand = floatingView.findViewById(R.id.btnExpand)
        btnClose = floatingView.findViewById(R.id.btnClose)

        adapter = LyricsAdapter(this, mutableListOf())
        lvLyrics.adapter = adapter

        // Layout parameters — bottom sheet anchored to bottom of screen
        val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            getScreenHeight() / 2,
            layoutType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )

        // Anchor to bottom
        params.gravity = Gravity.BOTTOM or Gravity.START
        params.x = 0
        params.y = 0

        windowManager.addView(floatingView, params)

        // Drag listener on the header (vertical drag only, adjusting y offset from bottom)
        var initialY = 0
        var initialTouchY = 0f

        val dragListener = View.OnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialY = params.y
                    initialTouchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dy = (initialTouchY - event.rawY).toInt()
                    params.y = (initialY + dy).coerceAtLeast(0)
                    windowManager.updateViewLayout(floatingView, params)
                    true
                }
                else -> false
            }
        }

        // Free drag listener for the floating pill (bubble)
        var bubbleInitialX = 0
        var bubbleInitialY = 0
        var bubbleInitialTouchX = 0f
        var bubbleInitialTouchY = 0f
        var bubbleIsDragging = false

        val bubbleDragListener = View.OnTouchListener { view, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    bubbleInitialX = params.x
                    bubbleInitialY = params.y
                    bubbleInitialTouchX = event.rawX
                    bubbleInitialTouchY = event.rawY
                    bubbleIsDragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - bubbleInitialTouchX).toInt()
                    val dy = (event.rawY - bubbleInitialTouchY).toInt()
                    
                    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                        bubbleIsDragging = true
                    }
                    
                    if (bubbleIsDragging) {
                        params.x = bubbleInitialX + dx
                        params.y = bubbleInitialY - dy
                        windowManager.updateViewLayout(floatingView, params)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!bubbleIsDragging) {
                        view.performClick()
                    }
                    true
                }
                else -> false
            }
        }

        layoutHeader.setOnTouchListener(dragListener)
        layoutBubble.setOnTouchListener(bubbleDragListener)

        // Minimize / Restore interactions
        btnMinimize.setOnClickListener { minimize() }
        layoutBubble.setOnClickListener { restore() }
        btnExpand.setOnClickListener { restore() }
        btnShare.setOnClickListener { /* Share intent placeholder */ }
        
        btnEdit.setOnClickListener {
            if (currentLyrics.isEmpty()) return@setOnClickListener
            val intent = Intent(this, EditLyricsActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("trackName", currentTrackName)
                putExtra("artistName", currentArtistName)
                val jsonList = Gson().toJson(currentLyrics)
                putExtra("lyricsJson", jsonList)
            }
            startActivity(intent)
        }

        btnClose.setOnClickListener {
            stopSelf()
        }
    }

    private fun minimize() {
        isMinimized = true
        layoutMain.visibility = View.GONE
        layoutBubble.visibility = View.VISIBLE
        
        params.width = WindowManager.LayoutParams.MATCH_PARENT
        params.height = WindowManager.LayoutParams.WRAP_CONTENT
        params.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        params.x = 0
        params.y = getScreenHeight() / 6
        windowManager.updateViewLayout(floatingView, params)
    }

    private fun restore() {
        isMinimized = false
        layoutMain.visibility = View.VISIBLE
        layoutBubble.visibility = View.GONE
        params.width = WindowManager.LayoutParams.MATCH_PARENT
        params.height = getScreenHeight() / 2
        params.gravity = Gravity.BOTTOM or Gravity.START
        params.x = 0
        params.y = 0
        windowManager.updateViewLayout(floatingView, params)
    }

    // --- Spotify Listener Callbacks ---

    override fun onTrackChanged(title: String, artist: String) {
        if (title.isEmpty()) return

        currentTrackName = title
        currentArtistName = artist

        updateNotification("Playing: $title - $artist")

        lyricsFetchJob?.cancel()
        lyricsFetchJob = serviceScope.launch(Dispatchers.Main) {
            // Reset UI
            adapter.clear()
            adapter.notifyDataSetChanged()
            currentLyrics = emptyList()
            currentActiveIndex = -1
            tvBubbleLyric.text = "\u266a"
            tvBubbleTranslation.text = ""
            tvBubbleTranslation.visibility = View.GONE
            tvStatus.visibility = View.VISIBLE
            tvStatus.text = "Checking cache..."

            // 0. Firebase / local cache (populated by desktop extension with Spotify lyrics)
            val cached = withContext(Dispatchers.IO) { getCachedLyrics(title, artist) }
            if (cached != null && cached.isNotEmpty()) {
                Log.d(TAG, "Cache hit for $title")
                displayLyrics(cached)
                return@launch
            }


            // 1. Spotify lyrics — use known track ID or search by title+artist
            tvStatus.text = "Fetching Spotify lyrics..."
            var rawLyrics: List<LyricLine>? = null
            var spotifyLanguage = ""

            val spotifyResult = withContext(Dispatchers.IO) {
                fetchSpotifyLyrics(
                    trackId = SpotifyPlaybackManager.currentTrackId,
                    title = title,
                    artist = artist
                )
            }
            if (spotifyResult != null) {
                rawLyrics = spotifyResult.lines
                spotifyLanguage = spotifyResult.language
                Log.d(TAG, "Spotify lyrics fetched for $title (lang=$spotifyLanguage, lines=${rawLyrics.size})")
            }

            // 2. LRCLIB fallback
            if (rawLyrics == null || rawLyrics.isEmpty()) {
                tvStatus.text = "Fetching lyrics (LRCLIB)..."
                rawLyrics = withContext(Dispatchers.IO) { fetchLyrics(title, artist) }
            }

            if (rawLyrics != null && rawLyrics.isNotEmpty()) {
                // 3. Translation pipeline
                val finalLyrics = withContext(Dispatchers.IO) {
                    translateIfNeeded(rawLyrics, spotifyLanguage, artist, title)
                }
                withContext(Dispatchers.IO) { saveCachedLyrics(title, artist, finalLyrics) }
                displayLyrics(finalLyrics)
            } else {
                tvStatus.text = "No lyrics found."
            }
        }
    }

    private fun displayLyrics(lyrics: List<LyricLine>) {
        currentLyrics = lyrics
        adapter.clear()
        adapter.addAll(lyrics)
        adapter.notifyDataSetChanged()
        tvStatus.visibility = View.GONE
    }

    /** Runs the translation pipeline only if the lyrics are not already in English. */
    private suspend fun translateIfNeeded(
        rawLyrics: List<LyricLine>,
        language: String,
        artist: String,
        title: String
    ): List<LyricLine> {
        // Already English — no translation needed
        if (language == "en") return rawLyrics

        // Native translation already present (e.g., Spotify returned an English alternative)
        if (rawLyrics.any { !it.translation.isNullOrEmpty() }) return rawLyrics

        // Netease human translation
        val netease = fetchNeteaseTranslation(artist, title, rawLyrics)
        if (netease != null) return netease

        // Gemini AI translation
        val apiKey = BuildConfig.GEMINI_API_KEY
        if (apiKey.isNotBlank()) {
            val gemini = translateWithGemini(rawLyrics, apiKey)
            if (gemini != null) return gemini
        }

        // Google Translate batch fallback
        return translateBatch(rawLyrics)
    }


    // --- Caching and Sequence Translation Helpers ---

    private fun getCacheKey(title: String, artist: String): String {
        val input = "${artist.lowercase().trim()}_${title.lowercase().trim()}"
        return try {
            val md = MessageDigest.getInstance("MD5")
            val digest = md.digest(input.toByteArray(Charsets.UTF_8))
            digest.joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            input.replace("[^a-zA-Z0-9]".toRegex(), "_")
        }
    }

    private fun getCacheFile(title: String, artist: String): File {
        val cacheDir = File(cacheDir, "lyrics_cache")
        if (!cacheDir.exists()) {
            cacheDir.mkdirs()
        }
        val key = getCacheKey(title, artist)
        return File(cacheDir, "$key.json")
    }

    private fun normalizeString(str: String?): String {
        if (str.isNullOrBlank()) return ""
        var clean = str.replace(Regex("\\s*[\\(\\[-].*$"), "")
        clean = clean.replace(Regex("[^a-zA-Z0-9\\s]"), "")
        return clean.replace(Regex("\\s+"), " ").trim().lowercase()
    }

    private fun getPrimaryArtist(artistStr: String?): String {
        if (artistStr.isNullOrBlank()) return ""
        val parts = artistStr.split(Regex("[,;&]|\\bfeat\\b|\\bft\\b", RegexOption.IGNORE_CASE))
        return parts.firstOrNull()?.trim() ?: ""
    }

    private fun getSyncKey(title: String, artist: String): String {
        val primaryArtist = getPrimaryArtist(artist)
        val normArtist = normalizeString(primaryArtist)
        val normTitle = normalizeString(title)
        val input = "${normArtist}_${normTitle}"
        return try {
            val md = MessageDigest.getInstance("SHA-256")
            val digest = md.digest(input.toByteArray(Charsets.UTF_8))
            digest.joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            input.replace("[^a-zA-Z0-9]".toRegex(), "_")
        }
    }


    private suspend fun getCachedLyrics(title: String, artist: String): List<LyricLine>? {
        // 1. Check local file cache
        try {
            val file = getCacheFile(title, artist)
            if (file.exists()) {
                val jsonStr = file.readText(Charsets.UTF_8)
                val type = object : com.google.gson.reflect.TypeToken<List<LyricLine>>() {}.type
                val localData: List<LyricLine> = Gson().fromJson(jsonStr, type)
                if (localData.isNotEmpty()) return localData
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read local cached lyrics", e)
        }

        // 2. Check Firebase Cloud
        try {
            val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
            val syncKey = getSyncKey(title, artist)
            val docSnap = db.collection("lyrics").document(syncKey).get().await()
            if (docSnap.exists()) {
                val lyricsList = docSnap.get("lyrics") as? List<Map<String, Any>>
                if (lyricsList != null) {
                    val cloudData = lyricsList.map {
                        LyricLine(
                            startTimeMs = (it["startTimeMs"] as? Number)?.toLong() ?: 0L,
                            words = it["words"] as? String ?: "",
                            translation = it["translation"] as? String
                        )
                    }
                    saveCachedLyricsLocal(title, artist, cloudData)
                    Log.d(TAG, "Fetched lyrics from Firebase for $title")
                    return cloudData
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Firebase fetch failed", e)
        }

        return null
    }

    private fun saveCachedLyricsLocal(title: String, artist: String, lines: List<LyricLine>) {
        try {
            val file = getCacheFile(title, artist)
            val jsonStr = Gson().toJson(lines)
            file.writeText(jsonStr, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save lyrics to local cache", e)
        }
    }

    private suspend fun saveCachedLyrics(title: String, artist: String, lines: List<LyricLine>) {
        saveCachedLyricsLocal(title, artist, lines)

        // Upload to Firebase Cloud
        try {
            val db = com.google.firebase.firestore.FirebaseFirestore.getInstance()
            val syncKey = getSyncKey(title, artist)
            val mappedLines = lines.map {
                mapOf(
                    "startTimeMs" to it.startTimeMs,
                    "words" to it.words,
                    "translation" to it.translation
                )
            }
            val data = hashMapOf("lyrics" to mappedLines)
            db.collection("lyrics").document(syncKey).set(data).await()
            Log.d(TAG, "Uploaded lyrics to Firebase for $title")
        } catch (e: Exception) {
            Log.w(TAG, "Firebase upload failed", e)
        }
    }

    private suspend fun fetchNeteaseTranslation(artist: String, title: String, rawLyrics: List<LyricLine>): List<LyricLine>? {
        val client = OkHttpClient()
        try {
            val primaryArtist = getPrimaryArtist(artist)
            val searchQuery = "$primaryArtist $title"
            val searchUrl = "https://music.163.com/api/search/get/web?s=" + URLEncoder.encode(searchQuery, "UTF-8") + "&type=1&limit=1"
            val searchRequest = Request.Builder().url(searchUrl).build()
            val searchResponse = withContext(Dispatchers.IO) { client.newCall(searchRequest).execute() }
            if (!searchResponse.isSuccessful) return null
            val searchBody = searchResponse.body?.string() ?: return null
            
            val searchJson = Gson().fromJson(searchBody, JsonObject::class.java)
            val songs = searchJson.getAsJsonObject("result")?.getAsJsonArray("songs")
            if (songs == null || songs.size() == 0) return null
            val songId = songs.get(0).asJsonObject.get("id").asLong

            val lyricUrl = "https://music.163.com/api/song/lyric?id=$songId&lv=1&kv=1&tv=-1"
            val lyricRequest = Request.Builder().url(lyricUrl).build()
            val lyricResponse = withContext(Dispatchers.IO) { client.newCall(lyricRequest).execute() }
            if (!lyricResponse.isSuccessful) return null
            val lyricBody = lyricResponse.body?.string() ?: return null
            
            val lyricJson = Gson().fromJson(lyricBody, JsonObject::class.java)
            val tlyric = lyricJson.getAsJsonObject("tlyric")?.get("lyric")?.asString
            if (tlyric.isNullOrEmpty()) return null

            val parsedTLyrics = parseLrc(tlyric)
            if (parsedTLyrics.isEmpty()) return null

            // Check if translations contain Chinese
            var hasChinese = false
            for (line in parsedTLyrics) {
                if (line.words.contains("[\u4e00-\u9fa5]".toRegex())) {
                    hasChinese = true
                    break
                }
            }
            if (hasChinese) {
                Log.d(TAG, "Netease translation contains Chinese, skipping for English translation.")
                return null
            }

            // Align by timestamps (allow 1000ms drift)
            var alignedCount = 0
            val alignedLyrics = rawLyrics.map { origLine ->
                if (origLine.startTimeMs == -1L) {
                    origLine.copy()
                } else {
                    val match = parsedTLyrics.find { tLine ->
                        Math.abs(tLine.startTimeMs - origLine.startTimeMs) < 1000L
                    }
                    if (match != null && match.words.isNotEmpty()) {
                        alignedCount++
                        origLine.copy(translation = match.words)
                    } else {
                        origLine.copy()
                    }
                }
            }

            // If we aligned at least 30% of the lines, consider it a success
            if (alignedCount > 0 && (alignedCount.toFloat() / rawLyrics.size.toFloat()) > 0.3f) {
                Log.d(TAG, "Netease translation match success! Aligned $alignedCount/${rawLyrics.size} lines.")
                return alignedLyrics
            }
        } catch (e: Exception) {
            Log.w(TAG, "Netease translation lookup failed", e)
        }
        return null
    }

    private suspend fun translateWithGemini(lines: List<LyricLine>, apiKey: String): List<LyricLine>? {
        if (lines.isEmpty() || apiKey.isBlank()) return null
        
        val bulkLines = lines.mapIndexed { idx, line -> "$idx:: ${line.words}" }.joinToString("\n")
        val prompt = """
            Translate the following song lyrics into English.
            You must output ONLY the translated lines, one by one.
            Maintain the poetic context, meaning, and flow of the song, but translate it accurately.
            Prefix each line with its index (e.g. 0:: translated text) so they map back exactly.
            Do not add notes, markdown, explanation, or headers.
            
            Here are the lyrics:
            $bulkLines
        """.trimIndent()
        
        val client = OkHttpClient()
        val mediaType = "application/json; charset=utf-8".toMediaTypeOrNull()
        
        val requestBodyMap = mapOf(
            "contents" to listOf(
                mapOf(
                    "parts" to listOf(
                        mapOf("text" to prompt)
                    )
                )
            )
        )
        val jsonBody = Gson().toJson(requestBodyMap)
        val body = jsonBody.toRequestBody(mediaType)
        
        val url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=$apiKey"
        
        try {
            val request = Request.Builder()
                .url(url)
                .post(body)
                .build()
                
            val response = withContext(Dispatchers.IO) { client.newCall(request).execute() }
            if (!response.isSuccessful) {
                Log.w(TAG, "Gemini translation API returned error: ${response.code}")
                return null
            }
            
            val responseBody = response.body?.string() ?: return null
            val json = Gson().fromJson(responseBody, JsonObject::class.java)
            val candidates = json.getAsJsonArray("candidates")
            if (candidates == null || candidates.size() == 0) return null
            
            val content = candidates.get(0).asJsonObject.getAsJsonObject("content")
            val parts = content?.getAsJsonArray("parts")
            if (parts == null || parts.size() == 0) return null
            
            val text = parts.get(0).asJsonObject.get("text")?.asString ?: return null
            
            // Parse response and map back to lines
            val translations = Array<String?>(lines.size) { null }
            val tLines = text.split("\n")
            val indexRegex1 = "^(\\d+)::\\s*(.*)$".toRegex()
            val indexRegex2 = "^(\\d+)\\s*[:：]+\\s*(.*)$".toRegex()
            
            for (tLine in tLines) {
                val trimLine = tLine.trim()
                var match = indexRegex1.find(trimLine)
                if (match == null) {
                    match = indexRegex2.find(trimLine)
                }
                if (match != null) {
                    val idx = match.groupValues[1].toInt()
                    val txt = match.groupValues[2].trim()
                    if (idx in lines.indices) {
                        translations[idx] = txt
                    }
                }
            }
            
            return lines.mapIndexed { idx, line ->
                val t = translations[idx]
                val original = line.words.replace("[.,/#!$%^&*;:{}=\\-_`~()]".toRegex(), "").trim().lowercase()
                val trans = t?.replace("[.,/#!$%^&*;:{}=\\-_`~()]".toRegex(), "")?.trim()?.lowercase() ?: ""
                val translation = if (t != null && original != trans) t else null
                line.copy(translation = translation)
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Gemini translation request failed", e)
            return null
        }
    }

    override fun onPlaybackStateChanged(isPlaying: Boolean, positionMs: Long, durationMs: Long, playbackSpeed: Float) {
        syncJob?.cancel()
        if (isPlaying) {
            startSyncLoop()
        }
    }

    override fun onBackgroundColorChanged(color: Int) {
        currentBgColor = color
        serviceScope.launch(Dispatchers.Main) {
            val backgroundDrawable = layoutMain.background as? android.graphics.drawable.GradientDrawable
            backgroundDrawable?.setColor(color)
        }
    }

    // --- Lyrics Sync Interpolation Poller ---

    private fun startSyncLoop() {
        syncJob = serviceScope.launch {
            while (isActive) {
                if (currentLyrics.isNotEmpty()) {
                    val elapsed = SystemClock.elapsedRealtime() - SpotifyPlaybackManager.lastPositionUpdateTimeMs
                    val currentProgress = SpotifyPlaybackManager.lastPositionMs + (elapsed * SpotifyPlaybackManager.playbackSpeed).toLong()

                    var activeIndex = -1
                    for (i in currentLyrics.indices) {
                        if (currentLyrics[i].startTimeMs != -1L && currentLyrics[i].startTimeMs <= currentProgress) {
                            activeIndex = i
                        }
                    }

                    if (activeIndex != currentActiveIndex && activeIndex != -1) {
                        currentActiveIndex = activeIndex
                        adapter.activeIndex = activeIndex
                        adapter.notifyDataSetChanged()

                        // Update floating pill bubble with current lyric + translation
                        val activeLine = currentLyrics[activeIndex]
                        tvBubbleLyric.text = if (activeLine.words.isBlank()) "\u266a" else activeLine.words
                        if (!activeLine.translation.isNullOrEmpty()) {
                            tvBubbleTranslation.text = activeLine.translation
                            tvBubbleTranslation.visibility = View.VISIBLE
                        } else {
                            tvBubbleTranslation.visibility = View.GONE
                        }

                        // Centering scroll selection
                        lvLyrics.smoothScrollToPositionFromTop(activeIndex, lvLyrics.height / 2 - dpToPx(35))
                    }
                }
                delay(200)
            }
        }
    }

    // --- API Fetching / Translation Logic ---

    data class SpotifyLyricsResult(val lines: List<LyricLine>, val language: String)

    /**
     * Fetches lyrics from Spotify's internal color-lyrics endpoint.
     * If trackId is empty (broadcast not received), searches Spotify by title+artist to get it.
     * Uses an anonymous web-player token — no login required.
     */
    private suspend fun fetchSpotifyLyrics(
        trackId: String,
        title: String = "",
        artist: String = ""
    ): SpotifyLyricsResult? {
        val client = OkHttpClient()
        return try {
            // Step 1: Get anonymous web-player token
            val tokenRequest = Request.Builder()
                .url("https://open.spotify.com/get_access_token?reason=transport&productType=web_player")
                .addHeader("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")
                .addHeader("App-Platform", "WebPlayer")
                .addHeader("Accept", "application/json")
                .build()
            val tokenResp = withContext(Dispatchers.IO) { client.newCall(tokenRequest).execute() }
            if (!tokenResp.isSuccessful) {
                Log.w(TAG, "Spotify token fetch failed: ${tokenResp.code}")
                return null
            }
            val tokenBody = tokenResp.body?.string() ?: return null
            val tokenJson = Gson().fromJson(tokenBody, JsonObject::class.java)
            val accessToken = tokenJson.get("accessToken")?.asString ?: return null

            // Step 2: Resolve track ID — use broadcast ID or search Spotify
            val resolvedId = if (trackId.isNotEmpty()) {
                trackId
            } else if (title.isNotEmpty()) {
                val primaryArtist = getPrimaryArtist(artist)
                val cleanTitle = title.replace(Regex("\\s*[\\(\\[-].*$"), "").trim()
                val q = URLEncoder.encode("track:\"$cleanTitle\" artist:\"$primaryArtist\"", "UTF-8")
                val searchReq = Request.Builder()
                    .url("https://api.spotify.com/v1/search?q=$q&type=track&limit=1")
                    .addHeader("Authorization", "Bearer $accessToken")
                    .addHeader("Accept", "application/json")
                    .build()
                val searchResp = withContext(Dispatchers.IO) { client.newCall(searchReq).execute() }
                val searchBody = searchResp.body?.string()
                val foundId = if (searchResp.isSuccessful && searchBody != null) {
                    Gson().fromJson(searchBody, JsonObject::class.java)
                        ?.getAsJsonObject("tracks")
                        ?.getAsJsonArray("items")
                        ?.firstOrNull()
                        ?.asJsonObject?.get("id")?.asString
                } else null
                if (!foundId.isNullOrEmpty()) {
                    Log.d(TAG, "Spotify search found track ID: $foundId for \"$title\"")
                    SpotifyPlaybackManager.updateTrackId(foundId) // cache for next time
                }
                foundId
            } else null

            if (resolvedId.isNullOrEmpty()) {
                Log.w(TAG, "Could not resolve Spotify track ID for \"$title\"")
                return null
            }

            // Step 3: Fetch lyrics from color-lyrics endpoint
            val lyricsRequest = Request.Builder()
                .url("https://spclient.wg.spotify.com/color-lyrics/v2/track/$resolvedId?format=json&vnd.cache-control.not-store=1")
                .addHeader("Authorization", "Bearer $accessToken")
                .addHeader("App-Platform", "WebPlayer")
                .addHeader("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")
                .addHeader("Accept", "application/json")
                .build()
            val lyricsResp = withContext(Dispatchers.IO) { client.newCall(lyricsRequest).execute() }
            if (!lyricsResp.isSuccessful) {
                Log.w(TAG, "Spotify lyrics fetch failed: ${lyricsResp.code} for trackId=$resolvedId")
                return null
            }
            val lyricsBody = lyricsResp.body?.string() ?: return null
            val lyricsJson = Gson().fromJson(lyricsBody, JsonObject::class.java)
            val lyricsObj = lyricsJson.getAsJsonObject("lyrics") ?: return null
            val rawLines = lyricsObj.getAsJsonArray("lines") ?: return null
            val language = lyricsObj.get("language")?.asString ?: ""

            // Step 4: Check for Spotify's own English translation alternative
            val alternatives = lyricsObj.getAsJsonArray("alternatives")
            val engAltLines: JsonArray? = if (language != "en") {
                alternatives?.firstOrNull {
                    it.asJsonObject.get("language")?.asString == "en"
                }?.asJsonObject?.getAsJsonArray("lines")
            } else null

            val lines = rawLines.mapIndexed { idx, el ->
                val lineObj = el.asJsonObject
                val startMs = lineObj.get("startTimeMs")?.asString?.toLongOrNull() ?: 0L
                val words = lineObj.get("words")?.asString ?: ""
                val translation = engAltLines?.get(idx)?.asJsonObject
                    ?.get("words")?.asString?.takeIf { it.isNotBlank() }
                LyricLine(startMs, words, translation)
            }.filter { it.words.isNotBlank() }

            if (lines.isEmpty()) null else SpotifyLyricsResult(lines, language)
        } catch (e: Exception) {
            Log.w(TAG, "fetchSpotifyLyrics failed", e)
            null
        }
    }

    private suspend fun fetchLyrics(title: String, artist: String): List<LyricLine>? {

        val client = OkHttpClient()
        
        // Clean up title (remove features/mix tags for better lookup)
        val cleanTitle = title.replace(Regex("\\s*\\([^)]*\\)"), "").trim()
        val primaryArtist = getPrimaryArtist(artist)
        
        try {
            val url = "https://lrclib.net/api/lookup?artist_name=" + 
                    URLEncoder.encode(primaryArtist, "UTF-8") + 
                    "&track_name=" + URLEncoder.encode(cleanTitle, "UTF-8")
            
            val request = Request.Builder().url(url).build()
            val response = withContext(Dispatchers.IO) { client.newCall(request).execute() }
            if (response.isSuccessful) {
                val bodyStr = response.body?.string() ?: return null
                val json = Gson().fromJson(bodyStr, JsonObject::class.java)
                
                val syncedElement = json.get("syncedLyrics")
                if (syncedElement != null && !syncedElement.isJsonNull) {
                    val syncedLyrics = syncedElement.asString
                    if (syncedLyrics.isNotEmpty()) return parseLrc(syncedLyrics)
                }
                
                val plainElement = json.get("plainLyrics")
                if (plainElement != null && !plainElement.isJsonNull) {
                    val plainLyrics = plainElement.asString
                    if (plainLyrics.isNotEmpty()) {
                        return plainLyrics.split("\n").map { LyricLine(-1, it.trim()) }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "LrcLib Lookup failed, running search fallback", e)
        }

        // Try Search Fallback
        try {
            val query = "$primaryArtist $cleanTitle"
            val url = "https://lrclib.net/api/search?q=" + URLEncoder.encode(query, "UTF-8")

            val request = Request.Builder().url(url).build()
            val response = withContext(Dispatchers.IO) { client.newCall(request).execute() }
            if (response.isSuccessful) {
                val bodyStr = response.body?.string() ?: return null
                val array = Gson().fromJson(bodyStr, JsonArray::class.java)
                if (array.size() > 0) {
                    val bestMatch = array.get(0).asJsonObject
                    
                    val syncedElement = bestMatch.get("syncedLyrics")
                    if (syncedElement != null && !syncedElement.isJsonNull) {
                        val syncedLyrics = syncedElement.asString
                        if (syncedLyrics.isNotEmpty()) return parseLrc(syncedLyrics)
                    }
                    
                    val plainElement = bestMatch.get("plainLyrics")
                    if (plainElement != null && !plainElement.isJsonNull) {
                        val plainLyrics = plainElement.asString
                        if (plainLyrics.isNotEmpty()) {
                            return plainLyrics.split("\n").map { LyricLine(-1, it.trim()) }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "LrcLib Search fallback failed", e)
        }

        return null
    }

    private fun parseLrc(lrcText: String): List<LyricLine> {
        val lines = lrcText.split("\n")
        val result = mutableListOf<LyricLine>()
        val timeRegex = "\\[(\\d+):(\\d+)\\.(\\d+)\\]".toRegex()
        
        for (line in lines) {
            val match = timeRegex.find(line)
            if (match != null) {
                val min = match.groupValues[1].toLong()
                val sec = match.groupValues[2].toLong()
                val dec = match.groupValues[3]
                val ms = dec.toLong() * when (dec.length) {
                    2 -> 10
                    3 -> 1
                    else -> 100
                }
                val startTimeMs = (min * 60 + sec) * 1000 + ms
                val words = line.replace(timeRegex, "").trim()
                result.add(LyricLine(startTimeMs, words))
            } else {
                val cleanWords = line.replace("\\[.*\\]".toRegex(), "").trim()
                if (cleanWords.isNotEmpty()) {
                    result.add(LyricLine(-1, cleanWords))
                }
            }
        }
        return result
    }

    private suspend fun translateBatch(lines: List<LyricLine>): List<LyricLine> {
        if (lines.isEmpty()) return lines
        
        val translatedList = lines.map { it.copy() }.toMutableList()
        val chunks = mutableListOf<List<IndexedLine>>()
        var currentChunk = mutableListOf<IndexedLine>()
        var currentLength = 0
        
        lines.forEachIndexed { idx, line ->
            val entryText = "$idx:: ${line.words}"
            if (currentLength + entryText.length + 1 > 2000) {
                chunks.add(currentChunk)
                currentChunk = mutableListOf(IndexedLine(idx, line))
                currentLength = entryText.length
            } else {
                currentChunk.add(IndexedLine(idx, line))
                currentLength += entryText.length + 1
            }
        }
        if (currentChunk.isNotEmpty()) {
            chunks.add(currentChunk)
        }
        
        val client = OkHttpClient()
        
        for (chunk in chunks) {
            val formatted = chunk.map { "${it.index}:: ${it.line.words}" }
            val bulkText = formatted.joinToString("\n")
            
            try {
                val url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
                        URLEncoder.encode(bulkText, "UTF-8")
                
                val request = Request.Builder().url(url).build()
                val response = withContext(Dispatchers.IO) { client.newCall(request).execute() }
                if (!response.isSuccessful) continue
                val responseBody = response.body?.string() ?: continue
                
                val array = Gson().fromJson(responseBody, JsonArray::class.java)
                val segments = array.get(0).asJsonArray
                val translatedBuilder = StringBuilder()
                for (i in 0 until segments.size()) {
                    val segment = segments.get(i).asJsonArray
                    if (segment.size() > 0 && !segment.get(0).isJsonNull) {
                        translatedBuilder.append(segment.get(0).asString)
                    }
                }
                val translatedText = translatedBuilder.toString()
                
                val tLines = translatedText.split("\n")
                val indexRegex1 = "^(\\d+)::\\s*(.*)$".toRegex()
                val indexRegex2 = "^(\\d+)\\s*[:：]+\\s*(.*)$".toRegex()
                
                for (tLine in tLines) {
                    val trimLine = tLine.trim()
                    var match = indexRegex1.find(trimLine)
                    if (match == null) {
                        match = indexRegex2.find(trimLine)
                    }
                    if (match != null) {
                        val idx = match.groupValues[1].toInt()
                        val txt = match.groupValues[2].trim()
                        if (idx in 0 until translatedList.size) {
                            val original = translatedList[idx].words.replace("[.,/#!$%^&*;:{}=\\-_`~()]".toRegex(), "").trim().lowercase()
                            val trans = txt.replace("[.,/#!$%^&*;:{}=\\-_`~()]".toRegex(), "").trim().lowercase()
                            if (original != trans) {
                                translatedList[idx].translation = txt
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Translation chunk failed", e)
            }
        }
        return translatedList
    }

    private data class IndexedLine(val index: Int, val line: LyricLine)

    // --- Helper Utilities ---

    private fun dpToPx(dp: Int): Int {
        val density = resources.displayMetrics.density
        return (dp * density).toInt()
    }

    private fun getScreenHeight(): Int {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val metrics = wm.currentWindowMetrics
            metrics.bounds.height()
        } else {
            @Suppress("DEPRECATION")
            val display = wm.defaultDisplay
            val metrics = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            display.getMetrics(metrics)
            metrics.heightPixels
        }
    }

    private fun getScreenWidth(): Int {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val metrics = wm.currentWindowMetrics
            metrics.bounds.width()
        } else {
            @Suppress("DEPRECATION")
            val display = wm.defaultDisplay
            val metrics = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            display.getMetrics(metrics)
            metrics.widthPixels
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Lyrics Overlay Service Channel",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Running overlay window and listening to Spotify tracks"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(contentText: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Lyrics Overlay Active")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(contentText: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, createNotification(contentText))
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        serviceScope.cancel()
        SpotifyPlaybackManager.unregisterListener(this)
        
        try {
            unregisterReceiver(lyricsUpdateReceiver)
        } catch (e: Exception) {
            Log.e(TAG, "Error unregistering receiver", e)
        }

        if (::floatingView.isInitialized) {
            windowManager.removeView(floatingView)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- Custom ListView Adapter ---

    private class LyricsAdapter(context: Context, lines: List<LyricLine>) : 
        ArrayAdapter<LyricLine>(context, 0, lines) {
        
        var activeIndex: Int = -1

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(context).inflate(R.layout.lyric_item_layout, parent, false)
            val line = getItem(position)!!
            
            val tvOriginal = view.findViewById<TextView>(R.id.tvOriginal)
            val tvTranslation = view.findViewById<TextView>(R.id.tvTranslation)

            tvOriginal.text = line.words
            if (!line.translation.isNullOrEmpty()) {
                tvTranslation.text = line.translation
                tvTranslation.visibility = View.VISIBLE
            } else {
                tvTranslation.visibility = View.GONE
            }

            // Apply style matching Spotify bottom lyrics panel:
            // Active line: bold white, larger
            // Inactive lines: dimmed warm white, normal weight
            if (position == activeIndex) {
                tvOriginal.setTextColor(Color.parseColor("#FFFFFF"))   // Bright white — active
                tvOriginal.textSize = 22f
                tvOriginal.setTypeface(tvOriginal.typeface, android.graphics.Typeface.BOLD)
                tvTranslation.setTextColor(Color.parseColor("#C8A84B")) // Warm gold — active translation
                tvTranslation.textSize = 22f
                tvTranslation.setTypeface(tvTranslation.typeface, android.graphics.Typeface.BOLD)
            } else {
                tvOriginal.setTextColor(Color.parseColor("#80FFFFFF"))  // 50% dim warm white — inactive
                tvOriginal.textSize = 18f
                tvOriginal.setTypeface(tvOriginal.typeface, android.graphics.Typeface.BOLD)
                tvTranslation.setTextColor(Color.parseColor("#60C8A84B")) // Dim gold — inactive translation
                tvTranslation.textSize = 18f
                tvTranslation.setTypeface(tvTranslation.typeface, android.graphics.Typeface.BOLD)
            }

            return view
        }
    }
}
