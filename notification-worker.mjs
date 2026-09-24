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
    timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hourCycle:"h23"
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { dateKey:`${o.year}-${o.month}-${o.day}`, minutes:Number(o.hour)*60+Number(o.minute) };
}
function timeToMinutes(s) {
  const m = String(s||"").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1])*60+Number(m[2]) : null;
}
function scheduleTime(e) {
  if (e?.start) return timeToMinutes(e.start);
  const m = String(e?.time||"").split("-")[0].trim();
  return timeToMinutes(m);
}
function isGrantedToken(v) {
  return v && v.token && v.permission === "granted";
}
async function sendToTokens(tokens, title, body) {
  const usable = tokens.filter(isGrantedToken);
  let sent = 0;
  for (const row of usable) {
    try {
      await messaging.send({
        token: row.token,
        notification: { title, body },
        data: { title, body, url: "./" },
        webpush: { fcmOptions: { link: "./" } }
      });
      sent++;
    } catch (e) {
      const code = e?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        await db.ref(`notificationTokens/${row.tokenHash}`).remove().catch(()=>{});
      }
      console.warn("FCM送信失敗", row.tokenHash, code);
    }
  }
  return sent;
}
async function main() {
  const tokenSnap = await db.ref("notificationTokens").get();
  const tokens = Object.entries(tokenSnap.val() || {}).map(([tokenHash,v]) => ({...v,tokenHash}));
  const {dateKey,minutes:nowMin} = nowJstParts();

  // ① 管理者が追加・更新・削除したスケジュールの一斉通知
  const updateSnap = await db.ref("broadcast/scheduleUpdates").get();
  const updates = updateSnap.val() || {};
  const stateRef = db.ref("notificationWorkerState");
  const processedSnap = await stateRef.child("processedScheduleUpdates").get();
  const processed = processedSnap.val() || {};
  for (const [updateId,u] of Object.entries(updates)) {
    if (!u || processed[updateId]) continue;
    const s = u.schedule || {};
    const actionText = u.action === "added" ? "追加しました！" : u.action === "updated" ? "更新しました！" : "削除しました！";
    const body = u.action === "deleted"
      ? `「${s.name || "スケジュール"}」の予定を削除しました。`
      : `「${s.name || "スケジュール"}」\n${s.dateLabel || s.dateKey || ""} ${s.time || ""}`;
    await sendToTokens(tokens, `スケジュールを${actionText}`, body);
    processed[updateId] = true;
  }
  // processed mapが肥大化しないよう直近300件だけ残す
  const processedEntries = Object.entries(processed).slice(-300);
  await stateRef.child("processedScheduleUpdates").set(Object.fromEntries(processedEntries));

  // ② 遅延変更：お気に入り登録しているイベントだけ通知
  const delaySnap = await db.ref("scheduleDelays").get();
  const delays = delaySnap.val() || {};
  const prevDelaySnap = await stateRef.child("lastScheduleDelays").get();
  const prevDelays = prevDelaySnap.val() || {};
  for (const [id,value] of Object.entries(delays)) {
    const nowDelay = Number(value||0);
    const oldDelay = Number(prevDelays[id]||0);
    if (nowDelay === oldDelay) continue;
    const scheduleSnap = await db.ref(`schedule/${id}`).get();
    const e = scheduleSnap.val();
    if (!e || nowDelay <= 0) continue;
    const interested = tokens.filter(v => v.notificationPrefs?.delay !== false && Array.isArray(v.favorites) && v.favorites.map(String).includes(String(id)));
    await sendToTokens(interested, "お気に入りのイベントが遅延しています", `⭐ ${e.name}\n約${nowDelay}分遅れています。`);
  }
  await stateRef.child("lastScheduleDelays").set(delays);

  // ③ 開始10分前：お気に入り登録イベントだけ通知
  const scheduleSnap = await db.ref("schedule").get();
  const schedule = Object.values(scheduleSnap.val() || {}).filter(Boolean);
  const notifiedSnap = await stateRef.child("tenMinuteSent").get();
  const tenMinuteSent = notifiedSnap.val() || {};
  for (const e of schedule) {
    if (String(e.dateKey||"") !== dateKey) continue;
    if (e.start == null && e.time == null) continue;
    const base = scheduleTime(e);
    if (base == null) continue;
    const delay = Number(delays[e.id]||0);
    const adjusted = base + delay;
    const diff = adjusted - nowMin;
    if (diff < 0 || diff > 10) continue;
    const key = `${dateKey}_${e.id}_${adjusted}`;
    if (tenMinuteSent[key]) continue;
    const interested = tokens.filter(v => v.notificationPrefs?.tenMin !== false && Array.isArray(v.favorites) && v.favorites.map(String).includes(String(e.id)));
    await sendToTokens(interested, "まもなく開始します！", `⭐ ${e.name}\n開始予定：${e.time || e.start}`);
    tenMinuteSent[key] = true;
  }
  const tenEntries = Object.entries(tenMinuteSent).slice(-500);
  await stateRef.child("tenMinuteSent").set(Object.fromEntries(tenEntries));

  console.log(`JST日付: ${dateKey}`);
  console.log(`現在時刻: ${nowMin}`);
  console.log(`通知登録ユーザー: ${tokens.length}`);
  console.log("通知Worker完了");
  await app.delete();
}

main().catch(async e => {
  console.error(e);
  await app.delete().catch(()=>{});
  process.exitCode = 1;
});
