// Spotify Lyrics Translator — Spicetify Extension
// Dark Warm Theme. Single button: Full ↔ Bubble toggle.
// Portrait canvas fills right side of screen vertically.

(function LyricsTranslator() {
    if (!window.Spicetify || !Spicetify.Player || !Spicetify.Playbar || !Spicetify.Platform || !Spicetify.CosmosAsync) {
        setTimeout(LyricsTranslator, 100);
        return;
    }
    console.log("[LyricsTranslator] Initializing...");

    // ── Constants ─────────────────────────────────────────────────────────────
    const PAD_X       = 24;
    const HEADER_H    = 70;
    const LINE_GAP    = 20;   // gap between lyric groups

    // Full view: tall portrait (fills right side of screen)
    const FULL_W = Math.round((window.screen?.width || 1920) * 0.25);
    const FULL_H = window.screen?.height || 1080;
    // Bubble view: compact pill
    const BUBBLE_W = Math.round((window.screen?.width || 1920) * 0.5), BUBBLE_H = 140;

    // ── State ─────────────────────────────────────────────────────────────────
    let currentLyrics      = [];
    let linePositions      = [];   // top-Y of each lyric group
    let lineHeights        = [];   // total height of each lyric group (for spacing)
    let currentTrackUri    = "";
    let currentTrackName   = "Not Playing";
    let currentTrackArtist = "Open Spotify and play a track";
    let currentActiveIndex = -1;
    let statusText         = "";
    let viewMode           = "none"; // "none" | "full" | "bubble"

    let albumArt       = new Image();
    let albumArtLoaded = false;

    let currentScrollY = 0;
    let targetScrollY  = 0;
    let animFrameId    = null;
    let pipWindow      = null;

    // ── Canvas & Video ────────────────────────────────────────────────────────
    const lyricCanvas = document.createElement("canvas");
    lyricCanvas.width  = FULL_W;
    lyricCanvas.height = FULL_H;
    const ctx = lyricCanvas.getContext("2d");

    const lyricVideo = document.createElement("video");
    lyricVideo.muted     = true;
    lyricVideo.srcObject = lyricCanvas.captureStream(60);
    fill(FULL_W, FULL_H);
    lyricVideo.play().catch(e => console.warn("[LyricsTranslator] Video play failed:", e));

    function fill(w, h) {
        ctx.fillStyle = "#3D2E0F";
        ctx.fillRect(0, 0, w, h);
    }

    // ── PiP Lifecycle ─────────────────────────────────────────────────────────
    lyricVideo.addEventListener("enterpictureinpicture", () => {
        startDrawLoop();
        if (Spicetify.Player.data?.item) {
            syncLyricsForTrack(Spicetify.Player.data.item, true);
        }
    });

    lyricVideo.addEventListener("leavepictureinpicture", () => {
        viewMode = "none";
        stopDrawLoop();
        playbarBtn.element.classList.remove("active");
    });

    async function switchMode(newMode) {
        if (newMode === viewMode) return;

        const isDocPipSupported = typeof window.documentPictureInPicture !== "undefined" && window.documentPictureInPicture.requestWindow;

        if (isDocPipSupported) {
            if (newMode === "none") {
                if (pipWindow) {
                    pipWindow.close();
                    pipWindow = null;
                }
                viewMode = "none";
                playbarBtn.element.classList.remove("active");
                return;
            }

            const isOpeningNew = !pipWindow || pipWindow.closed;
            
            if (isOpeningNew) {
                try {
                    pipWindow = await window.documentPictureInPicture.requestWindow({
                        width: newMode === "bubble" ? BUBBLE_W : FULL_W,
                        height: newMode === "bubble" ? BUBBLE_H : FULL_H
                    });

                    setupPipWindow();

                    pipWindow.addEventListener("pagehide", () => {
                        viewMode = "none";
                        pipWindow = null;
                        playbarBtn.element.classList.remove("active");
                    });

                    // Trigger initial fetch when window opens
                    if (Spicetify.Player.data?.item) {
                        // Small delay to ensure DOM is ready
                        setTimeout(() => {
                            syncLyricsForTrack(Spicetify.Player.data.item, true);
                        }, 100);
                    }

                } catch (e) {
                    console.error("[LyricsTranslator] Document PiP failed:", e);
                    Spicetify.showNotification("Could not open lyrics window");
                    viewMode = "none";
                    playbarBtn.element.classList.remove("active");
                    return;
                }
            }

            viewMode = newMode;
            playbarBtn.element.classList.add("active");

            if (newMode === "bubble") {
                pipWindow.document.body.classList.add("mode-bubble");
                pipWindow.resizeTo(BUBBLE_W, BUBBLE_H);
            } else {
                pipWindow.document.body.classList.remove("mode-bubble");
                pipWindow.resizeTo(FULL_W, FULL_H);
            }

            updatePipDOM();

        } else {
            // Fallback to Video Picture-in-Picture
            const wasOpen = document.pictureInPictureElement != null;
            if (wasOpen) await document.exitPictureInPicture().catch(() => {});

            viewMode = newMode;
            if (newMode === "full") {
                lyricCanvas.width  = FULL_W;
                lyricCanvas.height = FULL_H;
                fill(FULL_W, FULL_H);
            } else if (newMode === "bubble") {
                lyricCanvas.width  = BUBBLE_W;
                lyricCanvas.height = BUBBLE_H;
                fill(BUBBLE_W, BUBBLE_H);
            }

            if (newMode !== "none") {
                playbarBtn.element.classList.add("active");
                await lyricVideo.requestPictureInPicture().catch(e => {
                    console.error("[LyricsTranslator] PiP failed:", e);
                    Spicetify.showNotification("Could not open lyrics window");
                    viewMode = "none";
                    playbarBtn.element.classList.remove("active");
                });
            } else {
                playbarBtn.element.classList.remove("active");
            }
        }
    }

    function makeDraggable(element, win) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;

        element.addEventListener("mousedown", (e) => {
            if (e.target.closest("button") || e.target.closest("svg")) return;
            isDragging = true;
            startX = e.screenX;
            startY = e.screenY;
            element.setPointerCapture?.(e.pointerId);
        });

        element.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const deltaX = e.screenX - startX;
            const deltaY = e.screenY - startY;
            if (deltaX !== 0 || deltaY !== 0) {
                win.moveBy(deltaX, deltaY);
                startX = e.screenX;
                startY = e.screenY;
            }
        });

        const stopDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            if (e.pointerId !== undefined) {
                element.releasePointerCapture?.(e.pointerId);
            }
        };

        element.addEventListener("mouseup", stopDrag);
        element.addEventListener("pointerup", stopDrag);
        element.addEventListener("lostpointercapture", stopDrag);
    }

    function setupPipWindow() {
        if (!pipWindow) return;
        const doc = pipWindow.document;

        const style = doc.createElement("style");
        style.textContent = `
            :root {
                --bg-color: #3D2E0F;
                --text-color: #FFFFFF;
                --accent-color: #C8A84B;
                --font-family: 'Inter', system-ui, -apple-system, sans-serif;
            }
            body {
                margin: 0;
                padding: 0;
                background-color: var(--bg-color);
                font-family: var(--font-family);
                color: var(--text-color);
                overflow: hidden;
                user-select: none;
                -webkit-font-smoothing: antialiased;
            }
            .app-container {
                width: 100vw;
                height: 100vh;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
            }

            /* Full Mode Styling */
            .full-layout {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
            }
            .header {
                height: 70px;
                min-height: 70px;
                display: flex;
                align-items: center;
                padding: 0 24px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                box-sizing: border-box;
                background-color: var(--bg-color);
                z-index: 10;
                cursor: grab;
            }
            .header:active {
                cursor: grabbing;
            }
            .album-art-container {
                width: 44px;
                height: 44px;
                border-radius: 6px;
                overflow: hidden;
                margin-right: 12px;
                background-color: rgba(255,255,255,0.05);
            }
            .album-art {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .track-info {
                flex-grow: 1;
                min-width: 0;
            }
            .track-name {
                font-size: 14px;
                font-weight: bold;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .track-artist {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.5);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-top: 2px;
            }
            .header-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .action-btn {
                background: none;
                border: none;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: rgba(255, 255, 255, 0.7);
                transition: all 0.2s ease;
            }
            .action-btn:hover {
                background-color: rgba(255, 255, 255, 0.1);
                color: #FFFFFF;
            }
            .action-btn svg {
                width: 20px;
                height: 20px;
                fill: currentColor;
            }

            .lyrics-container {
                flex-grow: 1;
                overflow-y: auto;
                padding: 180px 24px;
                box-sizing: border-box;
                scroll-behavior: smooth;
            }
            .lyrics-container::-webkit-scrollbar {
                display: none;
            }
            .lyric-group {
                margin-bottom: 24px;
                transition: all 0.3s cubic-bezier(0.25, 1, 0.5, 1);
                transform-origin: left center;
                opacity: 0.35;
                transform: scale(0.95);
            }
            .lyric-group.active {
                opacity: 1.0;
                transform: scale(1.0);
            }
            .lyric-text {
                font-size: 24px;
                line-height: 1.4;
                font-weight: 500;
                color: #FFFFFF;
                transition: all 0.3s ease;
            }
            .lyric-group.active .lyric-text {
                font-size: 38px;
                font-weight: 800;
                text-shadow: 0 0 12px rgba(255, 255, 255, 0.22);
            }
            .translation-text {
                font-size: 18px;
                line-height: 1.4;
                font-style: italic;
                color: var(--accent-color);
                margin-top: 6px;
                transition: all 0.3s ease;
            }
            .lyric-group.active .translation-text {
                font-size: 26px;
                font-weight: 700;
                margin-top: 12px;
            }

            /* Bubble Mode Styling */
            .bubble-layout {
                display: none;
                height: 100%;
                width: 100%;
                background-color: #2A1E08;
                align-items: center;
                justify-content: center;
                padding: 8px;
                box-sizing: border-box;
            }
            .bubble-pill {
                width: 100%;
                height: 100%;
                background-color: var(--bg-color);
                border: 1.5px solid rgba(200, 168, 75, 0.55);
                border-radius: 9999px;
                display: flex;
                align-items: center;
                padding: 0 24px;
                box-sizing: border-box;
                cursor: grab;
            }
            .bubble-pill:active {
                cursor: grabbing;
            }
            .bubble-text {
                flex-grow: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                text-align: center;
                margin-right: 12px;
            }
            .bubble-lyric {
                font-size: 22px;
                font-weight: bold;
                color: #FFFFFF;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                width: 100%;
                text-shadow: 0 0 8px rgba(255, 255, 255, 0.12);
            }
            .bubble-translation {
                font-size: 17px;
                font-style: italic;
                color: var(--accent-color);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                width: 100%;
                margin-top: 4px;
            }
            .bubble-actions {
                display: flex;
                align-items: center;
                gap: 4px;
                flex-shrink: 0;
            }

            /* Toggle Layouts */
            body.mode-bubble .full-layout {
                display: none;
            }
            body.mode-bubble .bubble-layout {
                display: flex;
            }
        `;
        doc.head.appendChild(style);

        const appContainer = doc.createElement("div");
        appContainer.className = "app-container";
        appContainer.innerHTML = `
            <!-- Full Mode Layout -->
            <div class="full-layout">
                <div class="header">
                    <div class="album-art-container">
                        <img class="album-art" />
                    </div>
                    <div class="track-info">
                        <div class="track-name">Loading...</div>
                        <div class="track-artist">Loading...</div>
                    </div>
                    <div class="header-actions">
                        <button class="action-btn config-btn" title="Set Gemini API Key">
                            <svg viewBox="0 0 24 24"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>
                        </button>
                        <button class="action-btn minimize-btn" title="Minimize to Bubble">
                            <svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
                        </button>
                        <button class="action-btn close-btn" title="Close">
                            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    </div>
                </div>
                <div class="lyrics-container"></div>
            </div>

            <!-- Bubble Mode Layout -->
            <div class="bubble-layout">
                <div class="bubble-pill">
                    <div class="bubble-text">
                        <div class="bubble-lyric">Loading...</div>
                        <div class="bubble-translation"></div>
                    </div>
                    <div class="bubble-actions">
                        <button class="action-btn expand-btn" title="Expand to Full Screen">
                            <svg viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6 1.41 1.41z"/></svg>
                        </button>
                        <button class="action-btn close-btn" title="Close">
                            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        doc.body.appendChild(appContainer);

        doc.querySelector(".minimize-btn").addEventListener("click", () => switchMode("bubble"));
        doc.querySelector(".expand-btn").addEventListener("click", () => switchMode("full"));
        doc.querySelectorAll(".close-btn").forEach(btn => {
            btn.addEventListener("click", () => switchMode("none"));
        });

        doc.querySelector(".config-btn").addEventListener("click", () => {
            const currentKey = localStorage.getItem("LyricsTranslator_GeminiKey") || "";
            const key = pipWindow.prompt("Enter your Google Gemini API Key (leave empty to fall back to Google Translate):", currentKey);
            if (key !== null) {
                localStorage.setItem("LyricsTranslator_GeminiKey", key.trim());
                pipWindow.alert("Gemini API Key saved!");
                if (Spicetify.Player.data?.item) {
                    syncLyricsForTrack(Spicetify.Player.data.item, true);
                }
            }
        });

        // Make elements draggable
        makeDraggable(doc.querySelector(".header"), pipWindow);
        makeDraggable(doc.querySelector(".bubble-pill"), pipWindow);
    }

    function updatePipDOM() {
        if (!pipWindow || pipWindow.closed) return;

        const doc = pipWindow.document;

        const trackNameEl = doc.querySelector(".track-name");
        if (trackNameEl) trackNameEl.textContent = currentTrackName;

        const trackArtistEl = doc.querySelector(".track-artist");
        if (trackArtistEl) trackArtistEl.textContent = currentTrackArtist;

        const albumArtEl = doc.querySelector(".album-art");
        if (albumArtEl) {
            if (albumArtLoaded && albumArt.src) {
                albumArtEl.src = albumArt.src;
                doc.querySelector(".album-art-container").style.display = "block";
            } else {
                albumArtEl.src = "";
                doc.querySelector(".album-art-container").style.display = "none";
            }
        }

        const lyricsContainer = doc.querySelector(".lyrics-container");
        if (lyricsContainer) {
            if (lyricsContainer.dataset.trackUri !== currentTrackUri || lyricsContainer.dataset.statusText !== statusText) {
                lyricsContainer.dataset.trackUri = currentTrackUri;
                lyricsContainer.dataset.statusText = statusText;
                lyricsContainer.innerHTML = "";

                if (statusText) {
                    const statusEl = doc.createElement("div");
                    statusEl.textContent = statusText;
                    statusEl.style.textAlign = "center";
                    statusEl.style.color = "rgba(255,255,255,0.4)";
                    statusEl.style.fontSize = "16px";
                    statusEl.style.padding = "20px";
                    lyricsContainer.appendChild(statusEl);
                } else if (currentLyrics.length === 0) {
                    const emptyEl = doc.createElement("div");
                    emptyEl.textContent = "No lyrics available.";
                    emptyEl.style.textAlign = "center";
                    emptyEl.style.color = "rgba(255,255,255,0.35)";
                    emptyEl.style.fontSize = "16px";
                    emptyEl.style.padding = "20px";
                    lyricsContainer.appendChild(emptyEl);
                } else {
                    currentLyrics.forEach((line, idx) => {
                        const group = doc.createElement("div");
                        group.className = "lyric-group";
                        group.dataset.index = idx;

                        const lyricText = doc.createElement("div");
                        lyricText.className = "lyric-text";
                        lyricText.textContent = line.words;
                        group.appendChild(lyricText);

                        if (line.translation) {
                            const transText = doc.createElement("div");
                            transText.className = "translation-text";
                            transText.textContent = line.translation;
                            group.appendChild(transText);
                        }

                        lyricsContainer.appendChild(group);
                    });
                }
            }
        }

        const activeGroup = doc.querySelector(`.lyric-group[data-index="${currentActiveIndex}"]`);
        const allGroups = doc.querySelectorAll(".lyric-group");
        allGroups.forEach(g => g.classList.remove("active"));

        if (activeGroup) {
            activeGroup.classList.add("active");
            
            const containerHeight = lyricsContainer.clientHeight;
            const groupTop = activeGroup.offsetTop;
            const groupHeight = activeGroup.clientHeight;
            lyricsContainer.scrollTop = groupTop - containerHeight / 2 + groupHeight / 2;
        }

        const bubbleLyric = doc.querySelector(".bubble-lyric");
        if (bubbleLyric) {
            const activeLine = currentLyrics[currentActiveIndex];
            bubbleLyric.textContent = activeLine?.words || (statusText || currentTrackName || "♪");
        }

        const bubbleTrans = doc.querySelector(".bubble-translation");
        if (bubbleTrans) {
            const activeLine = currentLyrics[currentActiveIndex];
            if (activeLine?.translation) {
                bubbleTrans.textContent = activeLine.translation;
                bubbleTrans.style.display = "block";
            } else {
                bubbleTrans.textContent = "";
                bubbleTrans.style.display = "none";
            }
        }
    }

    // ── Playbar Button — single button, cycles full ↔ bubble ─────────────────
    const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.69 10.56 9.18 9.5 10.5c-.66-.74-1.2-1.61-1.63-2.5h-2c.47 1.21 1.2 2.36 2.1 3.39L3.27 16l1.41 1.41 4.32-4.32 3.29 3.29 1.59-1.31zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;

    const playbarBtn = new Spicetify.Playbar.Button(
        "Lyrics Translator",
        icon,
        () => {
            if (viewMode === "none")   switchMode("full");
            else if (viewMode === "full")   switchMode("bubble");
            else if (viewMode === "bubble") switchMode("full");
        },
        false, false
    );

    // ── Song & Progress Events ────────────────────────────────────────────────
    Spicetify.Player.addEventListener("songchange", (e) => {
        if (!e?.data?.item) return;
        syncLyricsForTrack(e.data.item);
    });

    Spicetify.Player.addEventListener("onprogress", () => {
        if (!currentLyrics.length || viewMode === "none") return;
        const progress = Spicetify.Player.getProgress();

        let activeIndex = -1;
        for (let i = 0; i < currentLyrics.length; i++) {
            if (currentLyrics[i].startTimeMs !== -1 && currentLyrics[i].startTimeMs <= progress) {
                activeIndex = i;
            }
        }
        if (activeIndex !== currentActiveIndex && activeIndex !== -1) {
            currentActiveIndex = activeIndex;
            updatePipDOM();
        }
    });

    // ── Track Sync ────────────────────────────────────────────────────────────
    async function syncLyricsForTrack(track, force = false) {
        if (!force && track.uri === currentTrackUri && currentLyrics.length > 0) return;

        currentTrackUri    = track.uri;
        currentActiveIndex = -1;
        currentLyrics      = [];
        linePositions      = [];
        lineHeights        = [];
        currentScrollY     = 0;
        targetScrollY      = 0;

        currentTrackName   = track.name || "Unknown Track";
        currentTrackArtist = track.artists?.length > 0
            ? track.artists.map(a => a.name).join(", ")
            : "Unknown Artist";

        loadAlbumArt(track.metadata?.image_url || track.album?.images?.[0]?.url || "");

        if (viewMode === "none") return;

        // Check cache first
        statusText = "Checking cache...";
        updatePipDOM();
        const cached = await cacheGet(currentTrackUri, currentTrackArtist, currentTrackName);
        if (cached && cached.length > 0) {
            console.log("[LyricsTranslator] Cache hit for", currentTrackName);
            currentLyrics = cached;
            statusText = "";
            updatePipDOM();
            return;
        }

        statusText = "Fetching lyrics...";
        updatePipDOM();
        const lyricsResult = await fetchLyrics(track);

        if (lyricsResult?.lines?.length > 0) {
            const rawLyrics = lyricsResult.lines;
            const language = lyricsResult.language || "";
            let translated = null;

            // If the song is already in English, bypass translation completely
            if (language === "en") {
                console.log("[LyricsTranslator] Lyrics are already in English. Skipping translation.");
                translated = rawLyrics;
            }

            // 0. Spotify Native English Translation (First Priority)
            if (!translated) {
                const hasNativeTranslation = rawLyrics.some(l => l.translation);
                if (hasNativeTranslation) {
                    console.log("[LyricsTranslator] Using Spotify native English translation!");
                    translated = rawLyrics;
                }
            }

            if (!translated) {
                statusText = "Translating...";
                updatePipDOM();

                // 3. Human Translation (Netease)
                translated = await fetchNeteaseTranslation(currentTrackArtist, currentTrackName, rawLyrics);

                // 2. AI Translation (Gemini)
                if (!translated) {
                    const geminiKey = localStorage.getItem("LyricsTranslator_GeminiKey");
                    if (geminiKey) {
                        statusText = "Translating (Gemini)...";
                        updatePipDOM();
                        translated = await translateWithGemini(rawLyrics, geminiKey);
                    }
                }

                // 1. Google Translate Fallback
                if (!translated) {
                    statusText = "Translating (Google)...";
                    updatePipDOM();
                    translated = await translateBatch(rawLyrics);
                }
            }

            currentLyrics = translated || rawLyrics;
            statusText = "";

            // Save to Cache
            await cachePut(currentTrackUri, currentLyrics, currentTrackArtist, currentTrackName);

            updatePipDOM();
        } else {
            currentLyrics = [];
            statusText = "No lyrics found for this track.";
            updatePipDOM();
        }
    }

    function loadAlbumArt(url) {
        albumArtLoaded = false;
        if (!url) {
            updatePipDOM();
            return;
        }
        albumArt = new Image();
        albumArt.crossOrigin = "anonymous";
        albumArt.onload  = () => { albumArtLoaded = true; updatePipDOM(); };
        albumArt.onerror = () => { albumArtLoaded = false; updatePipDOM(); };
        albumArt.src = url;
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function wrapText(text, maxWidth, font) {
        if (!text) return [];
        ctx.font = font;
        const words = text.split(" ");
        const lines = [];
        let currentLine = "";
        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            if (ctx.measureText(testLine).width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) {
            lines.push(currentLine);
        }
        return lines;
    }

    // ── IndexedDB Cache & Firebase Sync ────────────────────────────────────────
    const DB_NAME = "LyricsTranslatorDB";
    const DB_VERSION = 1;
    const STORE_NAME = "lyrics";

    let db = null;
    let doc = null;
    let getDoc = null;
    let setDoc = null;

    async function initFirebase() {
        if (db) return;
        try {
            const firebaseApp = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
            const firebaseFirestore = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            
            const firebaseConfig = {
              apiKey: "AIzaSyA5wp4HI9sHm25DBDHxq-T1ygrf--zV6Z8",
              authDomain: "gen-lang-client-0538036842.firebaseapp.com",
              projectId: "gen-lang-client-0538036842",
              storageBucket: "gen-lang-client-0538036842.firebasestorage.app",
              messagingSenderId: "45147592856",
              appId: "1:45147592856:web:761644a8cf721a38f998ed",
              measurementId: "G-403JY8B6C9"
            };
            
            const app = firebaseApp.initializeApp(firebaseConfig);
            db = firebaseFirestore.getFirestore(app);
            doc = firebaseFirestore.doc;
            getDoc = firebaseFirestore.getDoc;
            setDoc = firebaseFirestore.setDoc;
            console.log("[LyricsTranslator] Firebase initialized successfully.");
        } catch (e) {
            console.error("[LyricsTranslator] Failed to initialize Firebase:", e);
        }
    }

    function normalizeString(str) {
        if (!str) return "";
        let clean = str.replace(/\s*[\(\[-].*$/g, "");
        clean = clean.replace(/[^a-zA-Z0-9\s]/g, "");
        return clean.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function getPrimaryArtist(artistStr) {
        if (!artistStr) return "";
        const parts = artistStr.split(/[,;&]|\bfeat\b|\bft\b/i);
        return parts[0].trim();
    }

    function sha256(ascii) {
        // Pure-JS SHA-256. State is rebuilt per call (no cached .h/.k on function).
        function rightRotate(value, amount) {
            return (value >>> amount) | (value << (32 - amount));
        }
        var mathPow = Math.pow;
        var maxWord = mathPow(2, 32);
        var i, j;
        var result = '';
        var words = [];
        var asciiLen = ascii.length * 8;

        // Build constants fresh every call so state never bleeds between calls
        var hash = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        ];
        var k = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
            0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
            0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
            0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
            0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
            0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
            0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
            0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];

        ascii += '\x80';
        while (ascii.length % 64 - 56) ascii += '\x00';
        for (i = 0; i < ascii.length; i++) {
            j = ascii.charCodeAt(i);
            if (j >> 8) return '';
            words[i >> 2] |= j << ((3 - i % 4) * 8);
        }
        words[words.length] = ((asciiLen / maxWord) | 0);
        words[words.length] = (asciiLen | 0);

        for (j = 0; j < words.length;) {
            var w = words.slice(j, j += 16);
            var oldHash = hash.slice(0);
            for (i = 0; i < 64; i++) {
                var w15 = w[i - 15], w2 = w[i - 2];
                var s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
                var s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
                var ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
                var maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
                var temp1 = hash[7] + (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) + ch + k[i] + (w[i] = (i < 16 ? w[i] : (w[i - 16] + s0 + w[i - 7] + s1) | 0));
                var temp2 = (rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22)) + maj;
                hash = [(temp1 + temp2) | 0].concat(hash.slice(0, 7));
                hash[4] = (hash[4] + temp1) | 0;
            }
            for (i = 0; i < 8; i++) {
                hash[i] = (hash[i] + oldHash[i]) | 0;
            }
        }
        for (i = 0; i < 8; i++) {
            var val = hash[i];
            if (val < 0) val += maxWord;
            result += val.toString(16).padStart(8, '0');
        }
        return result;
    }

    async function getSyncKey(artist, title) {
        const primaryArtist = getPrimaryArtist(artist);
        const normArtist = normalizeString(primaryArtist);
        const normTitle = normalizeString(title);
        const input = `${normArtist}_${normTitle}`;
        return sha256(input);
    }



    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (e) => reject(e.target.error);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
        });
    }

    async function cacheGet(key, artist, title) {
        try {
            // 1. Check local IndexedDB
            const localDb = await openDB();
            const localRes = await new Promise((resolve, reject) => {
                const transaction = localDb.transaction(STORE_NAME, "readonly");
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(key);
                request.onerror = (e) => reject(e.target.error);
                request.onsuccess = (e) => resolve(request.result);
            });
            if (localRes && localRes.length > 0) return localRes;

            // 2. Check Firebase Cloud
            await initFirebase();
            if (db && doc && getDoc) {
                const syncKey = await getSyncKey(artist, title);
                const docRef = doc(db, "lyrics", syncKey);
                const docSnap = await getDoc(docRef);
                if (docSnap.exists()) {
                    console.log("[LyricsTranslator] Fetched lyrics from Firebase for", title);
                    const cloudLyrics = docSnap.data().lyrics;
                    // Save to local cache so next time is instant
                    await cachePutLocal(key, cloudLyrics);
                    return cloudLyrics;
                }
            }
            return null;
        } catch (err) {
            console.warn("[LyricsTranslator] Cache get failed:", err);
            return null;
        }
    }

    async function cachePutLocal(key, val) {
        try {
            const localDb = await openDB();
            return new Promise((resolve, reject) => {
                const transaction = localDb.transaction(STORE_NAME, "readwrite");
                const store = transaction.objectStore(STORE_NAME);
                const request = store.put(val, key);
                request.onerror = (e) => reject(e.target.error);
                request.onsuccess = (e) => resolve();
            });
        } catch (err) {
            console.warn("[LyricsTranslator] Local cache put failed:", err);
        }
    }

    async function cachePut(key, val, artist, title) {
        // 1. Save to local IndexedDB
        await cachePutLocal(key, val);

        // 2. Upload to Firebase Cloud
        try {
            await initFirebase();
            if (db && doc && setDoc) {
                const syncKey = await getSyncKey(artist, title);
                const docRef = doc(db, "lyrics", syncKey);
                await setDoc(docRef, { lyrics: val });
                console.log("[LyricsTranslator] Uploaded lyrics to Firebase for", title);
            }
        } catch (err) {
            console.warn("[LyricsTranslator] Firebase upload failed:", err);
        }
    }

    // ── Translation Pipeline Sequence Helpers ─────────────────────────────────
    async function fetchNeteaseTranslation(artist, title, rawLyrics) {
        try {
            const primaryArtist = getPrimaryArtist(artist);
            const searchQuery = `${primaryArtist} ${title}`;
            const searchUrl = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(searchQuery)}&type=1&limit=1`;
            const searchRes = await fetch(searchUrl);
            if (!searchRes.ok) return null;
            const searchData = await searchRes.json();
            const songId = searchData?.result?.songs?.[0]?.id;
            if (!songId) return null;

            const lyricUrl = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`;
            const lyricRes = await fetch(lyricUrl);
            if (!lyricRes.ok) return null;
            const lyricData = await lyricRes.json();
            const tlyric = lyricData?.tlyric?.lyric;
            if (!tlyric) return null;

            const parsedTLyrics = parseLrc(tlyric);
            if (!parsedTLyrics || parsedTLyrics.length === 0) return null;

            // Check if translations contain Chinese. If they do, they are translated to Chinese, not English.
            let hasChinese = false;
            for (const line of parsedTLyrics) {
                if (/[\u4e00-\u9fa5]/.test(line.words)) {
                    hasChinese = true;
                    break;
                }
            }
            if (hasChinese) {
                console.log("[LyricsTranslator] Netease translation contains Chinese, skipping for English translation.");
                return null;
            }

            // Align by timestamps (allow 1000ms drift)
            let alignedCount = 0;
            const alignedLyrics = rawLyrics.map(origLine => {
                if (origLine.startTimeMs === -1) return { ...origLine };
                
                // Find matching timestamp in Netease
                const match = parsedTLyrics.find(tLine => 
                    Math.abs(tLine.startTimeMs - origLine.startTimeMs) < 1000
                );
                if (match && match.words) {
                    alignedCount++;
                    return { ...origLine, translation: match.words };
                }
                return { ...origLine };
            });

            // If we aligned at least 30% of the lines, consider it a success
            if (alignedCount > 0 && (alignedCount / rawLyrics.length) > 0.3) {
                console.log(`[LyricsTranslator] Netease translation match success! Aligned ${alignedCount}/${rawLyrics.length} lines.`);
                return alignedLyrics;
            }
        } catch (e) {
            console.warn("[LyricsTranslator] Netease translation lookup failed:", e);
        }
        return null;
    }

    async function translateWithGemini(lines, apiKey) {
        if (!lines.length || !apiKey) return null;

        // Batch the lines
        const bulkLines = lines.map((line, idx) => `${idx}:: ${line.words}`).join("\n");
        
        const prompt = `Translate the following song lyrics into English.
You must output ONLY the translated lines, one by one.
Maintain the poetic context, meaning, and flow of the song, but translate it accurately.
Prefix each line with its index (e.g. 0:: translated text) so they map back exactly.
Do not add notes, markdown, explanation, or headers.

Here are the lyrics:
\${bulkLines}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=\${apiKey}`;
        
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }]
                })
            });

            if (!response.ok) {
                console.warn("[LyricsTranslator] Gemini translation API returned error:", response.status);
                return null;
            }

            const data = await response.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) return null;

            // Parse output
            const translations = new Array(lines.length).fill(null);
            for (const tLine of text.split("\n")) {
                const m = /^(\d+)::\s*(.*)$/.exec(tLine.trim()) || /^(\d+)\s*[:：]+\s*(.*)$/.exec(tLine.trim());
                if (m) {
                    const idx = parseInt(m[1]);
                    if (idx >= 0 && idx < lines.length) {
                        translations[idx] = m[2].trim();
                    }
                }
            }

            // Map back
            return lines.map((line, idx) => {
                const t = translations[idx];
                const cleanOrig = line.words.replace(/[.,\\/#!\$%\\^&\\*;:{}=\\-_`~()]/g, "").trim().toLowerCase();
                const cleanT = t ? t.replace(/[.,\\/#!\$%\\^&\\*;:{}=\\-_`~()]/g, "").trim().toLowerCase() : "";
                return { ...line, translation: t && cleanOrig !== cleanT ? t : null };
            });

        } catch (e) {
            console.error("[LyricsTranslator] Gemini translation request failed:", e);
            return null;
        }
    }

    function updateLayout(W) {
        const maxTextW = W - PAD_X * 2;
        let y = 0;
        
        currentLyrics.forEach((line, idx) => {
            const targetRatio = (idx === currentActiveIndex) ? 1.0 : 0.0;
            if (line.activeRatio === undefined) {
                line.activeRatio = targetRatio;
            } else {
                line.activeRatio += (targetRatio - line.activeRatio) * 0.12;
                if (Math.abs(line.activeRatio - targetRatio) < 0.001) {
                    line.activeRatio = targetRatio;
                }
            }

            const activeRatio = line.activeRatio;

            // Interpolated sizes and spacing
            const lyricFontSize = lerp(24, 38, activeRatio);
            const transFontSize = lerp(18, 26, activeRatio);
            const lyricLineH = lerp(34, 50, activeRatio);
            const transLineH = lerp(26, 36, activeRatio);
            const internalGap = lerp(6, 12, activeRatio);
            const groupGap = lerp(24, 36, activeRatio);

            const lyricWeight = Math.round(lerp(500, 800, activeRatio));
            const transWeight = Math.round(lerp(400, 700, activeRatio));

            const lyricFont = `${lyricWeight} ${lyricFontSize}px 'Inter', system-ui, sans-serif`;
            const wrappedLyrics = wrapText(line.words, maxTextW, lyricFont);

            let wrappedTrans = [];
            if (line.translation) {
                const transFont = `italic ${transWeight} ${transFontSize}px 'Inter', system-ui, sans-serif`;
                wrappedTrans = wrapText(line.translation, maxTextW, transFont);
            }

            line.y = y;
            line.layout = {
                lyricFont,
                wrappedLyrics,
                lyricLineH,
                lyricFontSize,
                wrappedTrans,
                transLineH,
                transFontSize,
                internalGap,
                groupGap,
                lyricColor: `rgba(255, 255, 255, ${lerp(0.35, 1.0, activeRatio)})`,
                transColor: `rgba(200, 168, 75, ${lerp(0.4, 1.0, activeRatio)})`,
                shadowBlur: lerp(0, 12, activeRatio),
                shadowColor: `rgba(255, 255, 255, ${lerp(0.0, 0.22, activeRatio)})`
            };

            const lyricH = wrappedLyrics.length * lyricLineH;
            const transH = wrappedTrans.length > 0 ? (internalGap + wrappedTrans.length * transLineH) : 0;
            line.h = lyricH + transH + groupGap;

            y += line.h;
        });
    }

    // ── Lyrics Fetcher ────────────────────────────────────────────────────────
    async function fetchLyrics(track) {
        if (!track?.uri) return null;

        const trackId = track.uri.split(":")[2];
        if (trackId && track.uri.includes(":track:")) {
            try {
                const data = await Spicetify.CosmosAsync.get(`sp://color-lyrics/v2/track/${trackId}`);
                if (data?.lyrics?.lines) {
                    const engAlt = data.lyrics.alternatives?.find(alt => alt.language === "en");
                    const language = data.lyrics.language || "";
                    const lines = data.lyrics.lines.map((l, idx) => {
                        const lineVal = engAlt?.lines?.[idx];
                        const translation = typeof lineVal === 'string' ? lineVal : (lineVal?.words || null);
                        return {
                            startTimeMs: parseInt(l.startTimeMs || 0),
                            words: l.words || "",
                            translation: translation ? translation.trim() : null
                        };
                    });
                    return { lines, language };
                }
            } catch (e) { console.warn("[LyricsTranslator] Native lyrics failed:", e); }
        }

        const artist      = track.artists?.[0]?.name || "";
        const title       = track.name || "";
        const durationSec = Math.round((track.duration?.milliseconds || 0) / 1000);
        if (!artist || !title) return null;

        let data = null;
        try {
            const r = await fetch(`https://lrclib.net/api/lookup?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${durationSec}`);
            if (r.status === 200) data = await r.json();
        } catch (e) { console.warn("[LyricsTranslator] LRCLIB lookup failed:", e); }

        if (!data) {
            try {
                const cleanTitle = title.replace(/\s*[\(\[-].*$/g, "");
                const primaryArtist = track.artists?.[0]?.name || artist;
                const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(`${primaryArtist} ${cleanTitle}`)}`);
                if (r.status === 200) {
                    const results = await r.json();
                    if (results?.length > 0) data = results[0];
                }
            } catch (e) { console.error("[LyricsTranslator] LRCLIB search failed:", e); }
        }

        if (data?.syncedLyrics) return { lines: parseLrc(data.syncedLyrics), language: "" };
        if (data?.plainLyrics) return { lines: data.plainLyrics.split("\n").map(l => ({ startTimeMs: -1, words: l.trim() })), language: "" };
        return null;
    }

    function parseLrc(lrcText) {
        const re = /\[(\d+):(\d+)\.(\d+)\]/;
        return lrcText.split("\n").reduce((acc, line) => {
            const m = re.exec(line);
            if (m) {
                const ms    = (parseInt(m[1]) * 60 + parseInt(m[2])) * 1000
                            + parseInt(m[3]) * (m[3].length === 2 ? 10 : m[3].length === 3 ? 1 : 100);
                const words = line.replace(re, "").trim();
                if (words) acc.push({ startTimeMs: ms, words });
            } else {
                const words = line.replace(/\[.*?\]/, "").trim();
                if (words) acc.push({ startTimeMs: -1, words });
            }
            return acc;
        }, []);
    }

    // ── Translation Pipeline ──────────────────────────────────────────────────
    async function translateBatch(lines) {
        if (!lines.length) return lines;

        const chunks = [];
        let chunk = [], chunkLen = 0;
        lines.forEach((line, idx) => {
            const entry = `${idx}:: ${line.words}`;
            if (chunkLen + entry.length + 1 > 3000) {
                chunks.push(chunk); chunk = [{ line, idx }]; chunkLen = entry.length;
            } else {
                chunk.push({ line, idx }); chunkLen += entry.length + 1;
            }
        });
        if (chunk.length) chunks.push(chunk);

        const translations = new Array(lines.length).fill(null);
        for (const c of chunks) {
            const bulk = c.map(it => `${it.idx}:: ${it.line.words}`).join("\n");
            try {
                const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(bulk)}`);
                if (!r.ok) continue;
                const data = await r.json();
                const text = data?.[0]?.map(s => s[0]).join("") || "";
                for (const tLine of text.split("\n")) {
                    const m = /^(\d+)::\s*(.*)$/.exec(tLine.trim()) || /^(\d+)\s*[:：]+\s*(.*)$/.exec(tLine.trim());
                    if (m) {
                        const idx = parseInt(m[1]);
                        if (idx >= 0 && idx < lines.length) translations[idx] = m[2].trim();
                    }
                }
            } catch (e) { console.error("[LyricsTranslator] Translation failed:", e); }
        }

        return lines.map((line, idx) => {
            const t         = translations[idx];
            const cleanOrig = line.words.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim().toLowerCase();
            const cleanT    = t ? t.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim().toLowerCase() : "";
            return { ...line, translation: t && cleanOrig !== cleanT ? t : null };
        });
    }

    // ── Draw Loop ─────────────────────────────────────────────────────────────
    function startDrawLoop() {
        if (animFrameId) return;
        function loop() {
            if (viewMode === "none") { animFrameId = null; return; }
            
            if (viewMode === "full") {
                updateLayout(lyricCanvas.width);
                if (currentActiveIndex === -1) {
                    targetScrollY = 0;
                } else {
                    const activeLine = currentLyrics[currentActiveIndex];
                    if (activeLine && activeLine.layout) {
                        targetScrollY = activeLine.y + (activeLine.h - activeLine.layout.groupGap) / 2;
                    }
                }
            }
            
            currentScrollY += (targetScrollY - currentScrollY) * 0.07;
            viewMode === "bubble" ? drawBubble() : drawFull();
            animFrameId = requestAnimationFrame(loop);
        }
        animFrameId = requestAnimationFrame(loop);
    }

    function stopDrawLoop() {
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    }

    // ── Full View Draw ────────────────────────────────────────────────────────
    function drawFull() {
        const W = lyricCanvas.width, H = lyricCanvas.height;
        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = "#3D2E0F";
        ctx.fillRect(0, 0, W, H);

        // ── Header ──────────────────────────────────────────────────────────
        // Album art
        let titleX = PAD_X;
        if (albumArtLoaded && albumArt.complete) {
            ctx.save();
            const rx = PAD_X, ry = 13, rs = 44, r = 6;
            ctx.beginPath();
            ctx.moveTo(rx + r, ry);
            ctx.lineTo(rx + rs - r, ry);
            ctx.quadraticCurveTo(rx + rs, ry, rx + rs, ry + r);
            ctx.lineTo(rx + rs, ry + rs - r);
            ctx.quadraticCurveTo(rx + rs, ry + rs, rx + rs - r, ry + rs);
            ctx.lineTo(rx + r, ry + rs);
            ctx.quadraticCurveTo(rx, ry + rs, rx, ry + rs - r);
            ctx.lineTo(rx, ry + r);
            ctx.quadraticCurveTo(rx, ry, rx + r, ry);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(albumArt, rx, ry, rs, rs);
            ctx.restore();
            titleX = PAD_X + rs + 12;
        }

        ctx.textAlign = "left";
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "bold 14px 'Inter', system-ui, sans-serif";
        ctx.fillText(truncate(currentTrackName, W - titleX - PAD_X - 60), titleX, 34);

        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "12px 'Inter', system-ui, sans-serif";
        ctx.fillText(truncate(currentTrackArtist, W - titleX - PAD_X - 60), titleX, 52);

        // "Lyrics" label
        ctx.textAlign = "right";
        ctx.font = "bold 13px 'Inter', system-ui, sans-serif";
        ctx.fillStyle = "#C8A84B";
        ctx.fillText("Lyrics", W - PAD_X, 34);

        // Separator
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, HEADER_H); ctx.lineTo(W, HEADER_H); ctx.stroke();

        // ── Clip to lyrics area ──────────────────────────────────────────────
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, HEADER_H, W, H - HEADER_H);
        ctx.clip();

        if (statusText) {
            ctx.textAlign = "center";
            ctx.font      = "16px 'Inter', system-ui, sans-serif";
            ctx.fillStyle = "rgba(255,255,255,0.4)";
            ctx.fillText(statusText, W / 2, (H + HEADER_H) / 2);
        } else if (!currentLyrics.length) {
            ctx.textAlign = "center";
            ctx.font      = "16px 'Inter', system-ui, sans-serif";
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.fillText("No lyrics available.", W / 2, (H + HEADER_H) / 2);
        } else {
            const lyricsAreaH = H - HEADER_H;
            const originY     = HEADER_H + lyricsAreaH / 2;

            ctx.textAlign = "left";

            currentLyrics.forEach((line, idx) => {
                const layout = line.layout;
                if (!layout) return;

                // Top-Y of this group relative to scroll
                const groupTopY = originY + (line.y - currentScrollY);

                // Skip if off screen
                if (groupTopY + line.h < HEADER_H - 50) return;
                if (groupTopY > H + 50) return;

                // Draw original lyric (word-wrapped)
                ctx.fillStyle   = layout.lyricColor;
                ctx.font        = layout.lyricFont;
                ctx.shadowColor = layout.shadowColor;
                ctx.shadowBlur  = layout.shadowBlur;

                // Draw each wrapped line of original lyric
                layout.wrappedLyrics.forEach((lyricLine, lineIdx) => {
                    const baselineY = groupTopY + (lineIdx * layout.lyricLineH) + layout.lyricFontSize * 0.85; 
                    ctx.fillText(lyricLine, PAD_X, baselineY);
                });

                // Draw translation (word-wrapped)
                if (layout.wrappedTrans.length > 0) {
                    ctx.shadowColor = "transparent";
                    ctx.shadowBlur  = 0;
                    ctx.fillStyle   = layout.transColor;
                    
                    const transFont = `italic ${Math.round(lerp(400, 700, line.activeRatio))} ${layout.transFontSize}px 'Inter', system-ui, sans-serif`;
                    ctx.font = transFont;
                    
                    const lyricH = layout.wrappedLyrics.length * layout.lyricLineH;
                    layout.wrappedTrans.forEach((transLine, transIdx) => {
                        const baselineY = groupTopY + lyricH + layout.internalGap + (transIdx * layout.transLineH) + layout.transFontSize * 0.85;
                        ctx.fillText(transLine, PAD_X, baselineY);
                    });
                }
            });
        }
        ctx.restore();
    }

    // ── Bubble View Draw ──────────────────────────────────────────────────────
    function drawBubble() {
        const W = lyricCanvas.width, H = lyricCanvas.height;
        ctx.clearRect(0, 0, W, H);

        // Outer fill
        ctx.fillStyle = "#2A1E08";
        ctx.fillRect(0, 0, W, H);

        // Pill shape
        const PAD = 8, radius = (H - PAD * 2) / 2;
        ctx.save();
        roundRect(ctx, PAD, PAD, W - PAD * 2, H - PAD * 2, radius);
        ctx.fillStyle   = "#3D2E0F";
        ctx.fill();
        ctx.strokeStyle = "rgba(200,168,75,0.55)";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
        ctx.clip();

        const activeLine = currentLyrics[currentActiveIndex];
        const lyricText  = activeLine?.words || (statusText || currentTrackName || "♪");
        const transText  = activeLine?.translation || null;

        const hasTranslation = !!transText;
        const totalH = hasTranslation ? 60 : 30;
        let lyricY = H / 2 - totalH / 2 + 20;

        // Lyric
        ctx.textAlign   = "center";
        ctx.fillStyle   = "#FFFFFF";
        ctx.font        = "bold 22px 'Inter', system-ui, sans-serif";
        ctx.shadowColor = "rgba(255,255,255,0.12)";
        ctx.shadowBlur  = 8;
        ctx.fillText(truncate(lyricText, W - 56), W / 2, lyricY);

        // Translation
        if (hasTranslation) {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur  = 0;
            ctx.fillStyle   = "#C8A84B";
            ctx.font        = "italic 17px 'Inter', system-ui, sans-serif";
            ctx.fillText(truncate(transText, W - 64), W / 2, lyricY + 30);
        }

        ctx.restore();
    }

    // ── Canvas Helpers ────────────────────────────────────────────────────────


    function truncate(text, maxWidth) {
        if (!text) return "";
        if (ctx.measureText(text).width <= maxWidth) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
            else hi = mid - 1;
        }
        return text.slice(0, lo) + "…";
    }

    function roundRect(context, x, y, w, h, radius) {
        context.beginPath();
        context.moveTo(x + radius, y);
        context.lineTo(x + w - radius, y);
        context.quadraticCurveTo(x + w, y, x + w, y + radius);
        context.lineTo(x + w, y + h - radius);
        context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        context.lineTo(x + radius, y + h);
        context.quadraticCurveTo(x, y + h, x, y + h - radius);
        context.lineTo(x, y + radius);
        context.quadraticCurveTo(x, y, x + radius, y);
        context.closePath();
    }
})();
