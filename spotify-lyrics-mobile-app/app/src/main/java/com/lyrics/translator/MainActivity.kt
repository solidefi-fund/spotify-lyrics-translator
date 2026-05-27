package com.lyrics.translator

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var btnOverlayPermission: Button
    private lateinit var btnNotificationPermission: Button
    private lateinit var btnToggleService: Button
    private lateinit var tvStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        btnOverlayPermission    = findViewById(R.id.btnOverlayPermission)
        btnNotificationPermission = findViewById(R.id.btnNotificationPermission)
        btnToggleService        = findViewById(R.id.btnToggleService)
        tvStatus                = findViewById(R.id.tvStatus)

        btnOverlayPermission.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            }
        }

        btnNotificationPermission.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        btnToggleService.setOnClickListener {
            val serviceIntent = Intent(this, FloatingLyricsService::class.java)
            if (FloatingLyricsService.isRunning) {
                stopService(serviceIntent)
                btnToggleService.text = "Start Overlay Service"
                btnToggleService.backgroundTintList =
                    android.content.res.ColorStateList.valueOf(getColor(android.R.color.black))
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
                btnToggleService.text = "Stop Overlay Service"
                btnToggleService.backgroundTintList =
                    android.content.res.ColorStateList.valueOf(getColor(android.R.color.holo_red_dark))
            }
        }
    }

    override fun onResume() {
        super.onResume()
        updatePermissionsStatus()
    }

    private fun updatePermissionsStatus() {
        val hasOverlay      = checkOverlayPermission()
        val hasNotification = checkNotificationAccess()

        if (hasOverlay) {
            btnOverlayPermission.isEnabled = false
            btnOverlayPermission.text = "Overlay Permission Granted"
            btnOverlayPermission.backgroundTintList =
                android.content.res.ColorStateList.valueOf(getColor(android.R.color.darker_gray))
        } else {
            btnOverlayPermission.isEnabled = true
            btnOverlayPermission.text = "Grant Overlay Permission"
            btnOverlayPermission.backgroundTintList =
                android.content.res.ColorStateList.valueOf(getColor(android.R.color.holo_green_dark))
        }

        if (hasNotification) {
            btnNotificationPermission.isEnabled = false
            btnNotificationPermission.text = "Notification Access Granted"
            btnNotificationPermission.backgroundTintList =
                android.content.res.ColorStateList.valueOf(getColor(android.R.color.darker_gray))
        } else {
            btnNotificationPermission.isEnabled = true
            btnNotificationPermission.text = "Grant Notification Access"
            btnNotificationPermission.backgroundTintList =
                android.content.res.ColorStateList.valueOf(getColor(android.R.color.holo_green_dark))
        }

        if (hasOverlay && hasNotification) {
            tvStatus.text = "Ready to run"
            tvStatus.setTextColor(getColor(android.R.color.holo_green_dark))
            btnToggleService.isEnabled = true
            if (FloatingLyricsService.isRunning) {
                btnToggleService.text = "Stop Overlay Service"
                btnToggleService.backgroundTintList =
                    android.content.res.ColorStateList.valueOf(getColor(android.R.color.holo_red_dark))
            } else {
                btnToggleService.text = "Start Overlay Service"
                btnToggleService.backgroundTintList =
                    android.content.res.ColorStateList.valueOf(getColor(android.R.color.black))
            }
        } else {
            tvStatus.text = "Permissions required"
            tvStatus.setTextColor(getColor(android.R.color.holo_red_light))
            btnToggleService.isEnabled = false
        }
    }

    private fun checkOverlayPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Settings.canDrawOverlays(this)
        } else {
            true
        }
    }

    private fun checkNotificationAccess(): Boolean {
        val enabledListeners = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        val componentName = ComponentName(this, MediaSessionListenerService::class.java)
        return enabledListeners != null && enabledListeners.contains(componentName.flattenToString())
    }
}
