import { APP_BUILD_ID, RUNTIME_BUILD_STORAGE_KEY } from '@/lib/runtime-build'
import {
  BUILD_RELOAD_GUARD_KEY,
  MANUAL_REFRESH_AT_KEY,
} from '@/lib/app-update'

/** Inline script: one guarded reload per deploy when stored build id differs. */
export function buildMismatchReloadScript(): string | null {
  if (APP_BUILD_ID === 'dev' || APP_BUILD_ID === 'local') return null
  const k = RUNTIME_BUILD_STORAGE_KEY
  const rk = BUILD_RELOAD_GUARD_KEY
  const manualAt = MANUAL_REFRESH_AT_KEY
  const autoCount = 'alma_build_auto_reload_n'
  const b = APP_BUILD_ID
  return `(function(){try{
    // Capacitor native shell: never self-reload / wipe SW+caches on launch.
    // On a cold start over slow network this can loop or white-screen, forcing
    // the user to kill & reopen the app. Native updates via PwaBootstrap instead.
    var C=window.Capacitor;if(C&&C.isNativePlatform&&C.isNativePlatform())return;
    if(/[?&]_alma_v=/.test(location.search))return;
    var manual=sessionStorage.getItem(${JSON.stringify(manualAt)});
    if(manual&&Date.now()-Number(manual)<180000)return;
    var k=${JSON.stringify(k)};
    var rk=${JSON.stringify(rk)};
    var autoCount=${JSON.stringify(autoCount)};
    var b=${JSON.stringify(b)};
    var s=localStorage.getItem(k);
    if(!s){localStorage.setItem(k,b);return;}
    if(s===b)return;
    var n=Number(sessionStorage.getItem(autoCount)||0);
    if(n>=1){localStorage.setItem(k,b);return;}
    sessionStorage.setItem(autoCount,String(n+1));
    localStorage.setItem(k,b);
    if(sessionStorage.getItem(rk)===b)return;
    sessionStorage.setItem(rk,b);
    function reload(){location.reload();}
    if('serviceWorker' in navigator){
      navigator.serviceWorker.getRegistrations().then(function(r){
        return Promise.all(r.map(function(x){return x.unregister();}));
      }).then(function(){
        if('caches' in window)return caches.keys().then(function(keys){
          return Promise.all(keys.map(function(n){return caches.delete(n);}));
        });
      }).catch(function(){}).finally(reload);
    }else{reload();}
  }catch(e){}})();`
}
