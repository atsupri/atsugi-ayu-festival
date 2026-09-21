import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getMessaging } from "firebase-admin/messaging";


// =========================================================
// Firebase Admin SDK 初期化
// =========================================================

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://atsugi-ayu-festival-default-rtdb.firebaseio.com"
});

const db = getDatabase(app);
const messaging = getMessaging(app);


// =========================================================
// 日本時間
// =========================================================

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


// =========================================================
// 時刻を「0時からの分」に変換
// =========================================================

function minutesFromTime(value) {
  if (!value) return null;

  const match = String(value).match(/(\d{1,2}):(\d{2})/);

  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}


// =========================================================
// お気に入りデータを安全に配列化
// =========================================================

function normalizeFavorites(value) {
  if (!Array.isArray(value)) return [];

  return value.map(String);
}


// =========================================================
// 通知の重複送信防止
// =========================================================

async function claimNotification(path) {
  const ref = db.ref(path);

  const result = await ref.transaction(current => {

    // すでに取得済みなら何もしない
    if (current) return;

    return {
      claimedAt: Date.now()
    };
  });

  return result.committed;
}


// =========================================================
// 通知送信失敗時にclaimを削除
// =========================================================

async function removeClaim(path) {
  try {
    await db.ref(path).remove();
  } catch (error) {
    console.error(
      "通知claim削除エラー:",
      error
    );
  }
}


// =========================================================
// 複数ユーザーへFCM送信
// =========================================================

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

    const response =
      await messaging.sendEachForMulticast({

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


// =========================================================
// メイン処理
// =========================================================

async function main() {

  console.log("================================");
  console.log("鮎まつり通知Worker開始");
  console.log(new Date().toISOString());
  console.log("================================");


  // =======================================================
  // 現在時刻
  // =======================================================

  const now = getJSTDate();

  const todayKey = dateKeyJST(now);

  const currentMinutes =
    now.getUTCHours() * 60 +
    now.getUTCMinutes();

  console.log(
    "JST日付:",
    todayKey
  );

  console.log(
    "現在時刻:",
    currentMinutes
  );


  // =======================================================
  // Firebaseから必要なデータを取得
  // =======================================================

  const [
    scheduleSnapshot,
    tokensSnapshot,
    delaysSnapshot
  ] = await Promise.all([

    db
      .ref("schedule")
      .once("value"),

    db
      .ref("notificationTokens")
      .once("value"),

    db
      .ref("scheduleDelays")
      .once("value")

  ]);


  const scheduleData =
    scheduleSnapshot.val() || {};

  const tokenData =
    tokensSnapshot.val() || {};

  const delayData =
    delaysSnapshot.val() || {};


  // =======================================================
  // 通知登録ユーザー
  // =======================================================

  const users =
    Object.entries(tokenData)

      .map(([uid, data]) => ({
        uid,
        ...(data || {})
      }))

      .filter(user =>
        user.token
      );


  console.log(
    "通知登録ユーザー:",
    users.length
  );


  // =======================================================
  // スケジュール
  // =======================================================

  const events =
    Object.values(scheduleData)
      .filter(Boolean);


  // =========================================================
  // ① 開始10分前通知
  // =========================================================

  console.log("10分前通知チェック開始");


  for (const event of events) {

    if (!event.id) continue;


    const eventDate =
      String(event.dateKey || "");


    // 今日のイベントだけ
    if (eventDate !== todayKey) {
      continue;
    }


    // startがあればstart
    // なければtime
    const start =
      minutesFromTime(event.start) ??
      minutesFromTime(event.time);


    if (start === null) {
      continue;
    }


    // 現在の遅延時間
    const delay =
      Number(delayData[event.id] || 0);


    // 遅延後の実際の開始予定時刻
    const effectiveStart =
      start + delay;


    // 現在時刻との差
    const diff =
      effectiveStart - currentMinutes;


    /*
     * GitHub Actionsは5分間隔。
     *
     * そのため、
     *
     * 8～12分前
     *
     * を「10分前通知」の判定範囲にする。
     */

    if (diff < 8 || diff > 12) {
      continue;
    }


    // =====================================================
    // お気に入り登録ユーザーを確認
    // =====================================================

    for (const user of users) {

      const favorites =
        normalizeFavorites(
          user.favorites
        );


      if (
        !favorites.includes(
          String(event.id)
        )
      ) {
        continue;
      }


      // 10分前通知OFFならスキップ
      if (
        user.notificationPrefs &&
        user.notificationPrefs.tenMin === false
      ) {
        continue;
      }


      // ===================================================
      // 二重送信防止
      // ===================================================

      const dispatchPath =
        `notificationDispatch/${todayKey}/${event.id}/tenMin/${user.uid}`;


      const claimed =
        await claimNotification(
          dispatchPath
        );


      if (!claimed) {
        continue;
      }


      // ===================================================
      // 通知内容
      // ===================================================

      const eventName =
        event.name ||
        "お気に入りのイベント";


      const title =
        "まもなく開始します！";


      const body =
        `⭐ ${eventName}が約10分後に開始予定です。`;


      // ===================================================
      // FCM送信
      // ===================================================

      try {

        await messaging.send({

          token: user.token,

          notification: {
            title,
            body
          },

          data: {
            type: "ten-minute",
            eventId: String(event.id),
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
          `10分前通知送信: ${user.uid} / ${eventName}`
        );


      } catch (error) {

        console.error(
          `10分前通知失敗: ${user.uid}`,
          error.message
        );


        // 送信失敗ならclaimを解除
        await removeClaim(
          dispatchPath
        );
      }
    }
  }


  // =========================================================
  // ② 遅延通知
  // =========================================================

  console.log("遅延通知チェック開始");


  // 前回保存した遅延状態
  const previousDelaySnapshot =
    await db
      .ref("notificationState/delays")
      .once("value");


  const previousDelays =
    previousDelaySnapshot.val() || {};


  for (const event of events) {

    if (!event.id) {
      continue;
    }


    const id =
      String(event.id);


    const oldDelay =
      Number(
        previousDelays[id] || 0
      );


    const newDelay =
      Number(
        delayData[id] || 0
      );


    /*
     * 初回実行時など、
     * 前回と今回が同じなら通知しない。
     */

    if (oldDelay === newDelay) {
      continue;
    }


    // 0分への変更は通知しない
    if (newDelay <= 0) {
      continue;
    }


    // =====================================================
    // お気に入りユーザーだけ通知
    // =====================================================

    for (const user of users) {

      const favorites =
        normalizeFavorites(
          user.favorites
        );


      if (
        !favorites.includes(id)
      ) {
        continue;
      }


      // 遅延通知OFFならスキップ
      if (
        user.notificationPrefs &&
        user.notificationPrefs.delay === false
      ) {
        continue;
      }


      // ===================================================
      // 二重送信防止
      // ===================================================

      const dispatchPath =
        `notificationDispatch/${todayKey}/${id}/delay/${user.uid}/${newDelay}`;


      const claimed =
        await claimNotification(
          dispatchPath
        );


      if (!claimed) {
        continue;
      }


      // ===================================================
      // 通知内容
      // ===================================================

      const eventName =
        event.name ||
        "お気に入りのイベント";


      const title =
        "お気に入りのイベントが遅延しています";


      const body =
        `⭐ ${eventName}\n約${newDelay}分遅れています。`;


      // ===================================================
      // FCM送信
      // ===================================================

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


        // 送信失敗ならclaim解除
        await removeClaim(
          dispatchPath
        );
      }
    }
  }


  // =========================================================
  // 今回確認した遅延状態を保存
  // =========================================================

  await db
    .ref("notificationState/delays")
    .set(delayData);


  console.log("通知Worker完了");
}


// =========================================================
// Worker実行
// =========================================================

try {

  await main();

} catch (error) {

  console.error(
    "通知Worker全体エラー:",
    error
  );

  process.exitCode = 1;

} finally {

  // Firebase Admin SDKを終了
  try {

    await app.delete();

    console.log(
      "Firebase接続を終了しました。"
    );

  } catch (error) {

    console.error(
      "Firebase終了処理エラー:",
      error
    );
  }
}
