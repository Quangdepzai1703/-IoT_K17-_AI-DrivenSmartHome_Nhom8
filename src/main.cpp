/*
 * ============================================================
 *  SMART DOOR — ESP32S NodeMCU CP2102
 *  Keypad 4×4 + Servo SG90 + RFID RC522 + MQTT
 * ============================================================
 *  Mật khẩu mặc định : 1234  (đổi được qua MQTT)
 *  Nhấn # để xác nhận | * để xóa
 *  Cửa tự khóa lại sau 3 giây
 * ============================================================
 *  KEYPAD → ESP32S:
 *    ROW1 → GPIO13 | ROW2 → GPIO12
 *    ROW3 → GPIO14 | ROW4 → GPIO26
 *    COL1 → GPIO27 | COL2 → GPIO33
 *    COL3 → GPIO32 | COL4 → GPIO25
 *
 *  SERVO SG90:
 *    Signal → GPIO17 | VCC → VIN(5V) | GND → GND
 *
 *  RFID RC522:
 *    SDA  → GPIO5  | SCK  → GPIO18
 *    MOSI → GPIO23 | MISO → GPIO19
 *    RST  → GPIO22 | 3.3V → 3.3V | GND → GND
 * ============================================================
 */

#include <Arduino.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <SPI.h>
#include <MFRC522.h>
#include "mqtt_handler.h"

// ============================================================
//  CẤU HÌNH
// ============================================================
String currentPassword = "1234";   // đổi được qua MQTT
#define MAX_DIGITS      10
#define DOOR_OPEN_TIME  3000        // ms tự khóa

#define SERVO_PIN    17
#define SERVO_LOCK   0
#define SERVO_UNLOCK 90

#define RFID_SS_PIN  5
#define RFID_RST_PIN 22

// ============================================================
//  ĐỐI TƯỢNG
// ============================================================
Servo   doorServo;
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);

// ── Keypad 4×4 ──────────────────────────────────────────────
const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {26, 14, 12, 13};
byte colPins[COLS] = {25, 32, 33, 27};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

// ── UID thẻ RFID được phép ──────────────────────────────────
// Bước 1: để trống, upload → quẹt thẻ → Serial hiện UID
// Bước 2: điền UID vào đây → upload lại
byte authorizedUID[][4] = {
  // {0xA1, 0xB2, 0xC3, 0xD4},   // ← bỏ comment, điền UID thực
};
const int NUM_CARDS = sizeof(authorizedUID) / sizeof(authorizedUID[0]);

// ============================================================
//  BIẾN TRẠNG THÁI
// ============================================================
String        inputBuffer = "";
bool          doorOpen    = false;
unsigned long openTime    = 0;

// ============================================================
//  ĐIỀU KHIỂN CỬA
// ============================================================
void lockDoor() {
  doorServo.write(SERVO_LOCK);
  doorOpen = false;
  Serial.println("🔒 CỬA ĐÃ KHÓA");
  Serial.println("────────────────────────────────");
  Serial.println("Nhập mật khẩu + #  hoặc  quẹt thẻ:");
}

void unlockDoor(String method) {
  doorServo.write(SERVO_UNLOCK);
  doorOpen = true;
  openTime = millis();
  Serial.println("✅ " + method + " — CỬA MỞ!");
  Serial.printf("Tự khóa sau %d giây...\n", DOOR_OPEN_TIME / 1000);
  if (mqttClient.connected()) {
    publishEvent("door", method.c_str(), true);
    publishStatus();
  }
}

void wrongPassword() {
  Serial.println("❌ MẬT KHẨU SAI! Thử lại.");
  if (mqttClient.connected())
    publishEvent("keypad", "wrong_password", false);
  for (int i = 0; i < 2; i++) {
    doorServo.write(SERVO_LOCK + 15); delay(150);
    doorServo.write(SERVO_LOCK);      delay(150);
  }
}

void wrongCard(String uid) {
  Serial.println("❌ THẺ KHÔNG HỢP LỆ: " + uid);
  if (mqttClient.connected())
    publishEvent("rfid", ("wrong_card:" + uid).c_str(), false);
  for (int i = 0; i < 2; i++) {
    doorServo.write(SERVO_LOCK + 15); delay(150);
    doorServo.write(SERVO_LOCK);      delay(150);
  }
}

// ============================================================
//  RFID HELPERS
// ============================================================
bool isAuthorizedCard() {
  for (int i = 0; i < NUM_CARDS; i++) {
    bool ok = true;
    for (int j = 0; j < 4; j++)
      if (rfid.uid.uidByte[j] != authorizedUID[i][j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

String getUID() {
  String uid = "";
  for (int i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
    if (i < rfid.uid.size - 1) uid += ":";
  }
  uid.toUpperCase();
  return uid;
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  // RFID
  SPI.begin(18, 19, 23, RFID_SS_PIN);
  rfid.PCD_Init();
  Serial.printf("✓ RFID RC522 v%X\n", rfid.PCD_ReadRegister(rfid.VersionReg));

  // Servo
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  doorServo.setPeriodHertz(50);
  doorServo.attach(SERVO_PIN, 500, 2400);
  lockDoor();
  delay(300);

  // WiFi + MQTT
  mqttSetup();

  Serial.println("\n================================================");
  Serial.println("   SMART DOOR sẵn sàng!");
  Serial.printf ("   Mật khẩu : %s\n", currentPassword.c_str());
  Serial.printf ("   Số thẻ   : %d\n", NUM_CARDS);
  Serial.println("   MQTT:");
  Serial.println("   ← home/cmd/door     : unlock/lock");
  Serial.println("   ← home/cmd/password : đổi mật khẩu");
  Serial.println("   → home/door/event   : sự kiện");
  Serial.println("   → home/status       : trạng thái");
  Serial.println("================================================\n");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {

  mqttLoop();

  // Tự khóa sau DOOR_OPEN_TIME
  if (doorOpen && millis() - openTime >= DOOR_OPEN_TIME) {
    lockDoor();
    inputBuffer = "";
    if (mqttClient.connected()) publishStatus();
  }

  // ── KEYPAD ────────────────────────────────────────────────
  char key = keypad.getKey();
  if (key) {
    switch (key) {

      case '#':
        Serial.print("Đã nhập: [");
        for (int i = 0; i < (int)inputBuffer.length(); i++) Serial.print('*');
        Serial.println("]");
        if (inputBuffer == currentPassword) {
          unlockDoor("KEYPAD");
        } else {
          wrongPassword();
          Serial.println("Nhập lại:");
        }
        inputBuffer = "";
        break;

      case '*':
        inputBuffer = "";
        Serial.println("🔄 Đã xóa. Nhập lại:");
        break;

      case 'A': case 'B': case 'C': case 'D':
        break;

      default:
        if ((int)inputBuffer.length() < MAX_DIGITS) {
          inputBuffer += key;
          Serial.print("Nhập: ");
          for (int i = 0; i < (int)inputBuffer.length(); i++) Serial.print('*');
          Serial.println();
        } else {
          Serial.println("⚠️ Quá ký tự! Nhấn * để xóa.");
        }
        break;
    }
  }

  // ── RFID ──────────────────────────────────────────────────
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial())   return;

  String uid = getUID();
  Serial.println("🪪 UID: " + uid);

  if (NUM_CARDS == 0) {
    // Chưa có thẻ nào — in UID để người dùng copy vào code
    Serial.println("ℹ️  Chưa có thẻ đăng ký. Copy UID trên vào authorizedUID[]");
  } else if (isAuthorizedCard()) {
    unlockDoor("RFID");
  } else {
    wrongCard(uid);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}