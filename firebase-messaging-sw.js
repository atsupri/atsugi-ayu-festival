importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAJ6MmsgtmKb9opkgu2Q2BnwUm4MUG21Fxk",
  authDomain: "atsugi-ayu-festival.firebaseapp.com",
  projectId: "atsugi-ayu-festival",
  storageBucket: "atsugi-ayu-festival.firebasestorage.app",
  messagingSenderId: "371571796436",
  appId: "1:371571796436:web:4703b40e3f1e5f648b8e41",
  measurementId: "G-Y0W73T4552"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || payload.data?.title || "あつぎ鮎まつり案内";
  const body = payload.notification?.body || payload.data?.body || "新しいお知らせがあります。";
  const url = payload.data?.url || "./";

  return self.registration.showNotification(title, {
    body,
    icon: "./favicon.ico",
    badge: "./favicon.ico",
    data: { url }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification?.data?.url || "./";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
