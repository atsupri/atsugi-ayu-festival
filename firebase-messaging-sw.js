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
