import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getMessaging } from "firebase-admin/messaging";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://atsugi-ayu-festival-default-rtdb.firebaseio.com"
});
const db = getDatabase(app);
const messaging = getMessaging(app);
const TZ = "Asia/Tokyo";

function nowJstParts() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { dateKey: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}

function timeToMinutes(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function scheduleTime(e) {
  if (e?.start) return timeToMinutes(e.start);
  const m = String(e?.time || "").split("-")[0].trim();
  return timeToMinutes(m);
}

function isGrantedToken(v) {
  return !!(v && v.token && v.permission === "granted");
}

async function sendToTokens(tokens, title, body) {
  const usable = tokens.filter(isGrantedToken);
  let sent = 0;
  let failed = 0;
  for (const row of usable) {
    try {
      await messaging.send({
        token: row.token,
        // data-only通知に統一。Service Workerだけがシステム通知を表示するため、
        // FCM自動表示との二重通知を防ぐ。
        data: { title, body, url: "./" }
      });
      sent++;
    } catch (e) {
      failed++;
      const code = e?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        // 使えなくなったFCMトークンは次回以降の誤送信を防ぐため自動削除。
        await db.ref(`notificationTokens/${row.tokenHash}`).remove().catch(() => {});
        console.log(`無効FCMトークンを削除: ${row.tokenHash}`);
      }
      console.warn("FCM送信失敗", row.tokenHash, code);
    }
  }
  return { sent, failed, attempted: usable.length };
}

async function main() {
  const stateRef = db.ref("notificationWorkerState");
  const tokenSnap = await db.ref("notificationTokens").get();
  const tokens = Object.entries(tokenSnap.val() || {})
    .map(([tokenHash, v]) => ({ ...(v || {}), tokenHash }))
    .filter(isGrantedToken);

  const { dateKey, minutes: nowMin } = nowJstParts();
  const delaySnap = await db.ref("scheduleDelays").get();
  const delays = delaySnap.val() || {};

  let delayTargets = 0;
  let delaySent = 0;
  let delayFailed = 0;

  // ① 遅延通知：お気に入り登録しているイベントだけ。
  const prevDelaySnap = await stateRef.child("lastScheduleDelays").get();
  const prevDelays = prevDelaySnap.val() || {};
  const delayIds = new Set([...Object.keys(delays), ...Object.keys(prevDelays)]);

  for (const id of delayIds) {
    const nowDelay = Number(delays[id] || 0);
    const oldDelay = Number(prevDelays[id] || 0);
    if (nowDelay === oldDelay) continue;

    const scheduleSnap = await db.ref(`schedule/${id}`).get();
    const e = scheduleSnap.val();

    // 0になった場合は状態だけ更新。通知は送らない。
    if (!e || nowDelay <= 0) continue;

    const interested = tokens.filter(v =>
      v.notificationPrefs?.delay !== false &&
      Array.isArray(v.favorites) &&
      v.favorites.map(String).includes(String(id))
    );

    delayTargets += interested.length;
    const result = await sendToTokens(
      interested,
      "お気に入りのイベントが遅延しています",
      `⭐ ${e.name}\n約${nowDelay}分遅れています。`
    );
    delaySent += result.sent;
    delayFailed += result.failed;
  }

  await stateRef.child("lastScheduleDelays").set(delays);

  let tenMinuteTargets = 0;
  let tenMinuteSent = 0;
  let tenMinuteFailed = 0;

  // ② 開始10分前：お気に入り登録イベントだけ。
  const scheduleSnap = await db.ref("schedule").get();
  const schedule = Object.values(scheduleSnap.val() || {}).filter(Boolean);
  const notifiedSnap = await stateRef.child("tenMinuteSent").get();
  const tenMinuteSentState = notifiedSnap.val() || {};

  for (const e of schedule) {
    if (String(e.dateKey || "") !== dateKey) continue;
    if (e.start == null && e.time == null) continue;

    const base = scheduleTime(e);
    if (base == null) continue;

    const delay = Number(delays[e.id] || 0);
    const adjusted = base + delay;
    const diff = adjusted - nowMin;

    // 0〜10分前の範囲だけ。開始済みのイベントには送らない。
    if (diff < 0 || diff > 10) continue;

    const key = `${dateKey}_${e.id}_${adjusted}`;
    if (tenMinuteSentState[key]) continue;

    const interested = tokens.filter(v =>
      v.notificationPrefs?.tenMin !== false &&
      Array.isArray(v.favorites) &&
      v.favorites.map(String).includes(String(e.id))
    );

    tenMinuteTargets += interested.length;
    const result = await sendToTokens(
      interested,
      "まもなく開始します！",
      `⭐ ${e.name}\n開始予定：${e.time || e.start}`
    );
    tenMinuteSent += result.sent;
    tenMinuteFailed += result.failed;

    // 対象者が0人でも、この時刻の送信判定は消化済みにする。
    tenMinuteSentState[key] = true;
  }

  const tenEntries = Object.entries(tenMinuteSentState).slice(-500);
  await stateRef.child("tenMinuteSent").set(Object.fromEntries(tenEntries));

  console.log(`JST日付: ${dateKey}`);
  console.log(`現在時刻: ${nowMin}`);
  console.log(`通知登録ユーザー: ${tokens.length}`);
  console.log(`10分前通知: 対象 ${tenMinuteTargets} / 送信 ${tenMinuteSent} / 失敗 ${tenMinuteFailed}`);
  console.log(`遅延通知: 対象 ${delayTargets} / 送信 ${delaySent} / 失敗 ${delayFailed}`);
  console.log("追加・更新・削除通知: 無効（送信しません）");
  console.log("通知Worker完了");
  await app.delete();
}

main().catch(async e => {
  console.error(e);
  await app.delete().catch(() => {});
  process.exitCode = 1;
});
