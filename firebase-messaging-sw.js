importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAJ6MmsgtmKb9opkgu2BnwUm4MUG21Fxk",
  authDomain: "atsugi-ayu-festival.firebaseapp.com",
  projectId: "atsugi-ayu-festival",
  storageBucket: "atsugi-ayu-festival.firebasestorage.app",
  messagingSenderId: "371571796436",
  appId: "1:371571796436:web:4703b40e3f1e5f648b8e41",
  measurementId: "G-Y0W73T4552"
});

const messaging = firebase.messaging();

// data-only FCMでも閉じたページで通知を表示できるようにする。
messaging.onBackgroundMessage((payload) => {
  console.log("FCM background message:", payload);

  const title = payload.notification?.title || payload.data?.title || "あつぎ鮎まつり案内";
  const body = payload.notification?.body || payload.data?.body || "新しいお知らせがあります。";
  const icon = payload.notification?.icon || payload.data?.icon || "/ayu-festival/icon-192.png";

  self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    data: { url: payload.data?.url || "/" }
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
