import { APP_BUILD_ID, RUNTIME_BUILD_STORAGE_KEY } from '@/lib/runtime-build'

/** Inline script: one guarded reload per deploy when stored build id differs. */
export function buildMismatchReloadScript(): string | null {
  if (APP_BUILD_ID === 'dev' || APP_BUILD_ID === 'local') return null
  const k = RUNTIME_BUILD_STORAGE_KEY
  const rk = 'alma_build_reload_guard'
  const b = APP_BUILD_ID
  return `(function(){try{var k=${JSON.stringify(k)};var rk=${JSON.stringify(rk)};var b=${JSON.stringify(b)};var s=localStorage.getItem(k);if(!s){localStorage.setItem(k,b);return;}if(s===b)return;localStorage.setItem(k,b);if(sessionStorage.getItem(rk)===b)return;sessionStorage.setItem(rk,b);function reload(){location.reload();}if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(r){return Promise.all(r.map(function(x){return x.unregister();}));}).then(function(){if('caches' in window)return caches.keys().then(function(keys){return Promise.all(keys.map(function(n){return caches.delete(n);}));});}).catch(function(){}).finally(reload);}else{reload();}}catch(e){}})();`
}
