#pragma once
// ============================================================
//  mqtt_handler.h — SMART DOOR
//  WiFi + MQTT (chỉ điều khiển cửa, chưa có DHT22)
// ============================================================
//  Subscribe (Web → ESP32):
//    home/cmd/door     → {"action":"unlock"|"lock"}
//    home/cmd/password → {"new":"5678"}
//
//  Publish (ESP32 → Web):
//    home/door/event   → {type, detail, granted, time}
//    home/status       → {door, uptime, ip}
//    home/online       → "1"
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ── Cấu hình — SỬA 3 DÒNG NÀY ──────────────────────────────
#define WIFI_SSID    "Quang1703"        // ← tên WiFi
#define WIFI_PASS    "MAT_KHAU_WIFI"    // ← mật khẩu WiFi
#define MQTT_SERVER  "10.25.81.69"      // ← IP máy tính
#define MQTT_PORT    1883
#define MQTT_CLIENT  "SmartDoor_ESP32"

// ── Topics ──────────────────────────────────────────────────
#define T_CMD_DOOR  "home/cmd/door"
#define T_CMD_PASS  "home/cmd/password"
#define T_DOOR_EVT  "home/door/event"
#define T_STATUS    "home/status"
#define T_ONLINE    "home/online"

// ── Extern từ main.cpp ──────────────────────────────────────
extern bool    doorOpen;
extern String  currentPassword;
extern void    unlockDoor(String method);
extern void    lockDoor();

// ── Objects ─────────────────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

static unsigned long _lastReconnect = 0;
static unsigned long _lastStatus    = 0;

// ============================================================
//  PUBLISH
// ============================================================
void publishEvent(const char* type, const char* detail, bool granted) {
  StaticJsonDocument<160> doc;
  doc["type"]    = type;
  doc["detail"]  = detail;
  doc["granted"] = granted;
  doc["time"]    = millis() / 1000;
  char buf[256];
  serializeJson(doc, buf);
  mqttClient.publish(T_DOOR_EVT, buf);
  Serial.printf("[MQTT] ↑ %s — %s\n", type, detail);
}

void publishStatus() {
  StaticJsonDocument<128> doc;
  doc["door"]   = doorOpen ? "open" : "locked";
  doc["uptime"] = millis() / 1000;
  doc["ip"]     = WiFi.localIP().toString();
  char buf[200];
  serializeJson(doc, buf);
  mqttClient.publish(T_STATUS, buf, true);
}

// ============================================================
//  CALLBACK — nhận lệnh từ Web
// ============================================================
void mqttCallback(char* topic, byte* payload, unsigned int len) {
  payload[len] = '\0';
  String msg = String((char*)payload);
  Serial.printf("[MQTT] ← %s : %s\n", topic, msg.c_str());

  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, msg) != DeserializationError::Ok) {
    Serial.println("[MQTT] ⚠ JSON lỗi"); return;
  }

  // home/cmd/door
  if (strcmp(topic, T_CMD_DOOR) == 0) {
    const char* action = doc["action"] | "";
    if (strcmp(action, "unlock") == 0) {
      unlockDoor("WEB REMOTE");
    } else if (strcmp(action, "lock") == 0) {
      lockDoor();
      publishEvent("remote", "lock_command", true);
    }
  }
  // home/cmd/password
  else if (strcmp(topic, T_CMD_PASS) == 0) {
    const char* np = doc["new"] | "";
    int pl = strlen(np);
    if (pl >= 4 && pl <= 10) {
      currentPassword = String(np);
      Serial.println("🔑 Mật khẩu đổi OK: " + currentPassword);
      publishEvent("system", "password_changed", true);
    } else {
      Serial.println("⚠ Mật khẩu không hợp lệ (4–10 ký tự)");
      publishEvent("system", "password_invalid", false);
    }
  }
}

// ============================================================
//  CONNECT
// ============================================================
void wifiConnect() {
  Serial.printf("📶 WiFi → %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 24) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf("\n✓ IP: %s\n", WiFi.localIP().toString().c_str());
  else
    Serial.println("\n⚠ WiFi thất bại — chạy offline");
}

bool mqttConnect() {
  if (WiFi.status() != WL_CONNECTED) return false;
  Serial.printf("📡 MQTT → %s:%d ... ", MQTT_SERVER, MQTT_PORT);
  if (mqttClient.connect(MQTT_CLIENT, nullptr, nullptr, T_ONLINE, 0, true, "0")) {
    Serial.println("✓ OK");
    mqttClient.subscribe(T_CMD_DOOR, 1);
    mqttClient.subscribe(T_CMD_PASS, 1);
    mqttClient.publish(T_ONLINE, "1", true);
    publishStatus();
    return true;
  }
  Serial.printf("✗ rc=%d\n", mqttClient.state());
  return false;
}

// ============================================================
//  SETUP & LOOP
// ============================================================
void mqttSetup() {
  wifiConnect();
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
  mqttConnect();
}

void mqttLoop() {
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - _lastReconnect > 5000) {
      _lastReconnect = now;
      Serial.println("[MQTT] Reconnecting...");
      mqttConnect();
    }
  }
  mqttClient.loop();

  // Gửi status mỗi 15 giây
  if (millis() - _lastStatus > 15000) {
    _lastStatus = millis();
    if (mqttClient.connected()) publishStatus();
  }
}