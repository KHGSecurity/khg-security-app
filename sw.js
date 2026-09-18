// KHG Security — service worker for push notifications.
// This runs in the background, separately from the main app page, and is
// what lets a notification appear even when the app itself isn't open.

self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function(event){
  var data = {};
  try{
    data = event.data ? event.data.json() : {};
  }catch(e){
    data = { title:'KHG Security', body: event.data ? event.data.text() : '' };
  }
  var title = data.title || 'KHG Security';
  var options = {
    body: data.body || '',
    icon: data.icon || 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(clientList){
      for(var i=0;i<clientList.length;i++){
        if('focus' in clientList[i]){ return clientList[i].focus(); }
      }
      if(self.clients.openWindow){ return self.clients.openWindow(url); }
    })
  );
});
