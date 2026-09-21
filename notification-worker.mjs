import * as admin from "firebase-admin";

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://atsugi-ayu-festival-default-rtdb.firebaseio.com"
});

const db = admin.database();
const messaging = admin.messaging();

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getJSTDate() {
  return new Date(Date.now() + JST_OFFSET_MS);
}

function dateKeyJST(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function minutesFromTime(value) {
  if (!value) return null;

  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeFavorites(value) {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

async function claimNotification(path) {
  const ref = db.ref(path);

  const result = await ref.transaction(current => {
    if (current) return;

    return {
      claimedAt: admin.database.ServerValue.TIMESTAMP
    };
  });

  return result.committed;
}

async function removeClaim(path) {
  try {
    await db.ref(path).remove();
  } catch (error) {
    console.error("通知claim削除エラー:", error);
  }
}

async function sendToUsers(users, title, body) {
  const validUsers = users.filter(user =>
    user &&
    user.token &&
    user.notificationPrefs &&
    user.notificationPrefs.delay !== false
  );

  let sent = 0;

  for (let i = 0; i < validUsers.length; i += 500) {
    const batch = validUsers.slice(i, i + 500);

    const tokens = batch.map(user => user.token);

    const response = await messaging.sendEachForMulticast({
      tokens,

      notification: {
        title,
        body
      },

      data: {
        title,
        body,
        type: "ayu-festival"
      },

      webpush: {
        notification: {
          title,
          body
        }
      }
    });

    sent += response.successCount;

    console.log(
      `FCM送信: 成功 ${response.successCount} / 失敗 ${response.failureCount}`
    );
  }

  return sent;
}

async function main() {
  console.log("================================");
  console.log("鮎まつり通知Worker開始");
  console.log(new Date().toISOString());
  console.log("================================");

  const now = getJSTDate();

  const todayKey = dateKeyJST(now);

  const currentMinutes =
    now.getUTCHours() * 60 +
    now.getUTCMinutes();

  console.log("JST日付:", todayKey);
  console.log("現在時刻:", currentMinutes);

  const [scheduleSnapshot, tokensSnapshot, delaysSnapshot] =
    await Promise.all([
      db.ref("schedule").once("value"),
      db.ref("notificationTokens").once("value"),
      db.ref("scheduleDelays").once("value")
    ]);

  const scheduleData = scheduleSnapshot.val() || {};
  const tokenData = tokensSnapshot.val() || {};
  const delayData = delaysSnapshot.val() || {};

  const users = Object.entries(tokenData)
    .map(([uid, data]) => ({
      uid,
      ...(data || {})
    }))
    .filter(user => user.token);

  console.log("通知登録ユーザー:", users.length);

  const events = Object.values(scheduleData)
    .filter(Boolean);

  /*
   * ==========================================
   * ① 開始10分前通知
   * ==========================================
   */

  for (const event of events) {
    if (!event.id) continue;

    const eventDate = String(event.dateKey || "");

    if (eventDate !== todayKey) continue;

    const start =
      minutesFromTime(event.start) ??
      minutesFromTime(event.time);

    if (start === null) continue;

    const delay = Number(delayData[event.id] || 0);

    // 遅延後の実際の開始予定時刻
    const effectiveStart = start + delay;

    const diff = effectiveStart - currentMinutes;

    /*
     * GitHub Actionsは5分間隔なので、
     * 「10分前付近」を8～12分前として判定。
     */
    if (diff < 8 || diff > 12) continue;

    for (const user of users) {
      const favorites = normalizeFavorites(user.favorites);

      if (!favorites.includes(String(event.id))) {
        continue;
      }

      if (
        user.notificationPrefs &&
        user.notificationPrefs.tenMin === false
      ) {
        continue;
      }

      const dispatchPath =
        `notificationDispatch/${todayKey}/${event.id}/tenMin/${user.uid}`;

      const claimed = await claimNotification(dispatchPath);

      if (!claimed) {
        continue;
      }

      const eventName =
        event.name || "お気に入りのイベント";

      const body =
        `⭐ ${eventName}が約10分後に開始予定です。`;

      try {
        await messaging.send({
          token: user.token,

          notification: {
            title: "まもなく開始します！",
            body
          },

          data: {
            type: "ten-minute",
            eventId: String(event.id),
            title: "まもなく開始します！",
            body
          },

          webpush: {
            notification: {
              title: "まもなく開始します！",
              body
            }
          }
        });

        console.log(
          `10分前通知送信: ${user.uid} / ${event.name}`
        );

      } catch (error) {
        console.error(
          `10分前通知失敗: ${user.uid}`,
          error.message
        );

        await removeClaim(dispatchPath);
      }
    }
  }

  /*
   * ==========================================
   * ② 遅延通知
   * ==========================================
   */

  const previousDelaySnapshot =
    await db.ref("notificationState/delays").once("value");

  const previousDelays =
    previousDelaySnapshot.val() || {};

  for (const event of events) {
    if (!event.id) continue;

    const id = String(event.id);

    const oldDelay =
      Number(previousDelays[id] || 0);

    const newDelay =
      Number(delayData[id] || 0);

    /*
     * 初回実行では既存の遅延を通知しない。
     * 次回以降、値が変化した場合だけ通知。
     */
    if (oldDelay === newDelay) {
      continue;
    }

    if (newDelay <= 0) {
      continue;
    }

    for (const user of users) {
      const favorites =
        normalizeFavorites(user.favorites);

      if (!favorites.includes(id)) {
        continue;
      }

      if (
        user.notificationPrefs &&
        user.notificationPrefs.delay === false
      ) {
        continue;
      }

      const dispatchPath =
        `notificationDispatch/${todayKey}/${id}/delay/${user.uid}/${newDelay}`;

      const claimed =
        await claimNotification(dispatchPath);

      if (!claimed) continue;

      const eventName =
        event.name || "お気に入りのイベント";

      const title =
        "お気に入りのイベントが遅延しています";

      const body =
        `⭐ ${eventName}\n約${newDelay}分遅れています。`;

      try {
        await messaging.send({
          token: user.token,

          notification: {
            title,
            body
          },

          data: {
            type: "delay",
            eventId: id,
            delay: String(newDelay),
            title,
            body
          },

          webpush: {
            notification: {
              title,
              body
            }
          }
        });

        console.log(
          `遅延通知送信: ${user.uid} / ${eventName} / ${newDelay}分`
        );

      } catch (error) {
        console.error(
          `遅延通知失敗: ${user.uid}`,
          error.message
        );

        await removeClaim(dispatchPath);
      }
    }
  }

  /*
   * 今回確認した遅延状態を保存
   */
  await db.ref("notificationState/delays").set(delayData);

  console.log("通知Worker完了");
}

try {
  await main();
} catch (error) {
  console.error("通知Worker全体エラー:", error);
  process.exitCode = 1;
} finally {
  try {
    await admin.app().delete();
    console.log("Firebase接続を終了しました。");
  } catch (error) {
    console.error("Firebase終了処理エラー:", error);
  }
}
