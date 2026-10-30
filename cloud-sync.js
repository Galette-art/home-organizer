(function(){
  const config = window.HOME_ORGANIZER_SUPABASE || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || '') &&
    !!config.anonKey && !String(config.anonKey).includes('YOUR_');
  const APP_BUILD = '2026-10-30-manual-sync-v1';
  let client = null, user = null, busy = false, suppress = false;
  const status = (message) => {
    const el = document.getElementById('cloudSyncStatus');
    if (el) el.textContent = message;
  };
  const authButtons = () => {
    const login = document.getElementById('cloudLoginButton');
    const logout = document.getElementById('cloudLogoutButton');
    const sync = document.getElementById('cloudSyncButton');
    const restore = document.getElementById('cloudRestoreButton');
    if (login) login.classList.toggle('hidden', !!user || !configured);
    if (logout) logout.classList.toggle('hidden', !user);
    if (sync) sync.classList.toggle('hidden', !user);
    if (restore) restore.classList.toggle('hidden', !user);
  };
  // --- Sync bookkeeping helpers -------------------------------------------
  // stringHash fingerprints a snapshot (or a photo data URL) so the sync can
  // tell "unchanged" apart from "changed" without keeping a second copy.
  function stringHash(value){
    const s = String(value ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'h' + h.toString(16) + '-' + s.length;
  }
  function snapshotHash(snapshot){ return stringHash(JSON.stringify(snapshot || null)); }
  function localDateString(){
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function syncStateKey(){ return user ? 'homeOrganizerCloudSyncState:' + user.id : ''; }
  function getSyncMarker(){
    try { const raw = localStorage.getItem(syncStateKey()); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function setSyncMarker(marker){
    try { localStorage.setItem(syncStateKey(), JSON.stringify(marker)); } catch (e) {}
  }
  function uploadedKey(){ return user ? 'homeOrganizerUploadedPhotos:' + user.id : ''; }
  function getUploadedMap(){
    try { return JSON.parse(localStorage.getItem(uploadedKey()) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function setUploadedMap(map){
    try { localStorage.setItem(uploadedKey(), JSON.stringify(map)); } catch (e) {}
  }
  async function init(){
    // Capture OAuth callback markers before Supabase cleans them from the URL.
    const oauthReturnUrl = new URL(window.location.href);
    const isOAuthCallback = oauthReturnUrl.searchParams.has('code') ||
      /(?:^|[&#])(?:access_token|refresh_token)=/.test(oauthReturnUrl.hash);

    if (!configured || !window.supabase || !window.supabase.createClient) {
      status('クラウド同期は未設定です。Supabaseプロジェクトの設定が必要です。端末内の保存とJSONバックアップは引き続き利用できます。');
      authButtons(); return;
    }
    client = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        storage: window.localStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) console.warn('Could not restore the saved Google session', sessionError);
    user = sessionData && sessionData.session ? sessionData.session.user : null;

    // OAuth may return to a cached copy of the app. After Supabase has saved
    // the session, reopen the same page with a build marker so the newest UI
    // (including swipe and quantity controls) is loaded. This does not change data.
    if (isOAuthCallback && user) {
      const freshUrl = new URL(oauthReturnUrl.href);
      ['code', 'state', 'error', 'error_code', 'error_description', '_app_refresh']
        .forEach((key) => freshUrl.searchParams.delete(key));
      freshUrl.hash = '';
      freshUrl.searchParams.set('_app_refresh', APP_BUILD + '-' + Date.now());
      if (freshUrl.href !== window.location.href) {
        window.location.replace(freshUrl.href);
        return;
      }
    }

    authButtons();
    status(user ? 'Googleアカウントに接続済みです。同期状態を確認しています。' : '未ログインです。端末内データはこの端末に保存されています。');
    client.auth.onAuthStateChange((event, session) => {
      user = session && session.user ? session.user : null;
      authButtons();
      if (user && event === 'SIGNED_IN') setTimeout(() => onSignedIn(), 0);
      if (!user) status('Googleアカウントにログインしていません。ログインするとクラウド同期を利用できます。端末内のデータはそのまま保持されます。');
    });
    if (user) await onSignedIn();
  }
  async function login(){
    if (!client) { status('クラウド設定が未完了です。'); return; }
    // Do not carry the one-time cache-refresh marker into Supabase's
    // redirect URL; keep the callback at the canonical GitHub Pages address.
    const redirectUrl = new URL(window.location.href);
    ['code', 'state', 'error', 'error_code', 'error_description', '_app_refresh']
      .forEach((key) => redirectUrl.searchParams.delete(key));
    redirectUrl.hash = '';
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl.toString() }
    });
    if (error) { console.error(error); status('Googleログインを開始できませんでした。Supabaseの認証設定を確認してください。'); }
  }

  async function logout(){
    if (!client) return;
    const key = initializedKey();
    const { error } = await client.auth.signOut();
    if (error) { console.error(error); status('ログアウトできませんでした。'); }
    else {
      if (key) localStorage.removeItem(key);
      user = null; authButtons();
      status('ログアウトしました。端末内のデータはそのまま保持されています。再ログイン時にクラウドデータとの同期を確認します。');
    }
  }
  function getLocalData(){ return window.HomeOrganizerGetData ? window.HomeOrganizerGetData() : null; }
  function getPhoto(id){ return window.HomeOrganizerGetPhoto ? window.HomeOrganizerGetPhoto(id) : Promise.resolve(''); }
  async function getPhotoRefs(snapshot){
    return [...(snapshot.items || []), ...(snapshot.locations || [])].map(x => x.photo).filter(x => x && String(x).startsWith('photo:'));
  }
  async function uploadPhotos(snapshot){
    const refs = [...new Set(await getPhotoRefs(snapshot))];
    // Skip photos whose content this device has already uploaded unchanged;
    // re-uploading every photo on every edit wasted bandwidth and made each
    // sync slower as the library grew.
    const uploaded = getUploadedMap();
    let uploadedChanged = false;
    for (const ref of refs) {
      const value = await getPhoto(ref);
      if (!value || !String(value).startsWith('data:')) throw new Error('端末内の写真が見つかりません: ' + ref);
      const hash = stringHash(value);
      if (uploaded[ref] === hash) continue;
      const response = await fetch(value);
      const blob = await response.blob();
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/gif' ? 'gif' : 'jpg';
      const path = user.id + '/' + encodeURIComponent(ref) + '.' + ext;
      const { error } = await client.storage.from('home-organizer-photos').upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
      if (error) throw error;
      uploaded[ref] = hash; uploadedChanged = true;
    }
    if (uploadedChanged) setUploadedMap(uploaded);
  }
  async function writeBackupOnly(snapshot){
    const { error } = await client.from('home_organizer_backups').upsert(
      { user_id: user.id, backup_date: localDateString(), data: snapshot },
      { onConflict: 'user_id,backup_date' });
    if (error) throw error;
  }
  async function saveSnapshot(snapshot, createDailyBackup, options){
    if (!snapshot) throw new Error('端末内データを取得できませんでした');
    const opts = options || {};
    // Conflict guard: if the cloud row changed since this device last synced
    // and its content differs from the local data, uploading would silently
    // destroy the other device's changes. Refuse with a SYNC_CONFLICT error
    // and let the caller preserve the cloud copy first (see syncNow).
    if (!opts.skipConflictCheck) {
      const remote = await fetchRemote();
      if (remote) {
        const marker = getSyncMarker();
        const localHash = snapshotHash(snapshot);
        const remoteHash = snapshotHash(remote.data);
        const remoteChanged = !marker || remote.updated_at !== marker.updatedAt;
        if (remoteChanged && localHash !== remoteHash) {
          const err = new Error('クラウド側に新しいデータがあるため、上書きしませんでした');
          err.code = 'SYNC_CONFLICT'; err.remote = remote;
          throw err;
        }
      }
    }
    await uploadPhotos(snapshot);
    const updatedAt = new Date().toISOString();
    const { error } = await client.from('home_organizer_data').upsert({ user_id: user.id, data: snapshot, updated_at: updatedAt }, { onConflict: 'user_id' });
    if (error) throw error;
    setSyncMarker({ updatedAt, hash: snapshotHash(snapshot) });
    if (createDailyBackup) {
      try { await writeBackupOnly(snapshot); }
      catch (backupError) { console.warn('Daily backup could not be written', backupError); }
    }
  }
  async function fetchRemote(){
    const { data, error } = await client.from('home_organizer_data').select('data,updated_at').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  async function restoreRemote(snapshot){
    const refs = await getPhotoRefs(snapshot);
    const replacements = new Map();
    for (const ref of refs) {
      const { data: files, error: listError } = await client.storage.from('home-organizer-photos').list(user.id, { search: encodeURIComponent(ref) });
      if (listError) throw listError;
      const file = (files || []).find(f => decodeURIComponent(f.name).startsWith(ref));
      if (!file) throw new Error('クラウドに写真がありません: ' + ref);
      const { data: blob, error } = await client.storage.from('home-organizer-photos').download(user.id + '/' + file.name);
      if (error) throw error;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
      replacements.set(ref, dataUrl);
    }
    const restored = JSON.parse(JSON.stringify(snapshot));
    for (const collection of [restored.items || [], restored.locations || []]) {
      for (const item of collection) {
        if (replacements.has(item.photo)) await window.HomeOrganizerPutPhoto(item.photo, replacements.get(item.photo));
      }
    }
    suppress = true;
    try { await window.HomeOrganizerSetData(restored); }
    finally { suppress = false; }
  }
  // Quietly compare the cloud copy with this device's data and report the
  // result as status text only. Nothing is uploaded or imported here:
  // backing up and restoring happen only when the user presses the
  // corresponding button (syncNow / restoreLatestBackup).
  async function refreshDifferenceStatus(){
    try {
      const remote = await fetchRemote();
      const local = getLocalData();
      if (!remote) {
        status('Googleアカウントに接続済みです。クラウドにバックアップはまだありません。「クラウドにバックアップ」を押すと、この端末のデータを保存できます。');
        return;
      }
      if (!local) { status('Googleアカウントに接続済みです。'); return; }
      const localHash = snapshotHash(local);
      const remoteHash = snapshotHash(remote.data);
      if (localHash === remoteHash) {
        setSyncMarker({ updatedAt: remote.updated_at, hash: localHash });
        status('Googleアカウントに接続済みです。クラウドのバックアップと一致しています。');
      } else {
        status('Googleアカウントに接続済みです。クラウドのバックアップと端末のデータに差分があります。保存は「クラウドにバックアップ」、取り込みは「クラウドバックアップから復元」から手動で行えます。');
      }
    } catch (e) {
      console.warn('Cloud difference check failed', e);
      status('Googleアカウントに接続済みです。クラウドの状態を確認できませんでした。');
    }
  }
  function initializedKey(){ return user ? 'homeOrganizerCloudInitialized:' + user.id : ''; }
  async function onSignedIn(){
    if (!client || !user || busy) return;
    // Sign-in never uploads or imports data and never asks via a popup.
    // It only reports whether the cloud copy and this device differ.
    const key = initializedKey();
    if (key) localStorage.setItem(key, '1');
    await refreshDifferenceStatus();
  }
  async function syncNow(){
    if (!client || !user || busy) return;
    busy = true; status('バックアップ中…');
    try { await saveSnapshot(getLocalData(), true); status('クラウドへのバックアップが完了しました。'); }
    catch (e) {
      if (e && e.code === 'SYNC_CONFLICT' && e.remote) {
        // The user pressed the backup button, so this device's data is what
        // they chose to save — no popup. Preserve the current cloud copy in
        // today's backup first (createDailyBackup stays false so the
        // preserved copy is not overwritten again by this same save), then
        // upload. The status text explains that the cloud copy can be
        // brought back from today's backup via the restore button.
        try {
          await writeBackupOnly(e.remote.data);
          await saveSnapshot(getLocalData(), false, { skipConflictCheck: true });
          status('クラウド側のデータは本日分のバックアップに保管したうえで、この端末のデータをバックアップしました。クラウド側の内容に戻したい場合は「クラウドバックアップから復元」を使ってください。');
        } catch (e2) { console.error(e2); status('バックアップできませんでした。端末内データは保持されています。'); }
      } else { console.error(e); status('バックアップできませんでした。端末内データは保持されています。'); }
    }
    finally { busy = false; }
  }
  // Called on every local data change. Backups are manual now, so this
  // never uploads anything; it only notes in the status line that there
  // are changes the user has not backed up yet.
  function schedule(snapshot){
    if (!client || !user || suppress || !snapshot) return;
    const marker = getSyncMarker();
    if (marker && marker.hash === snapshotHash(snapshot)) return;
    status('未バックアップの変更があります。「クラウドにバックアップ」を押すとクラウドに保存できます。');
  }
  window.addEventListener('online', () => {
    if (user && client && !busy) refreshDifferenceStatus();
  });
  // Manual restore, only from the restore button. Source priority: the
  // current cloud data when it differs from this device (e.g. backed up
  // from another device); otherwise the latest daily backup when it
  // differs (e.g. the cloud copy preserved during a conflicting backup).
  // The current local data is preserved in today's backup before restoring.
  async function restoreLatestBackup(){
    if (!client || !user || busy) return;
    busy = true;
    try {
      const local = getLocalData();
      const localHash = local ? snapshotHash(local) : '';
      const remote = await fetchRemote();
      let snapshot = null, label = '';
      if (remote && snapshotHash(remote.data) !== localHash) {
        snapshot = remote.data;
        label = 'クラウドの現在のデータ（' + String(remote.updated_at || '').slice(0, 10) + ' 更新）';
      } else {
        const { data, error } = await client.from('home_organizer_backups').select('backup_date,data').eq('user_id', user.id).order('backup_date', { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (data && snapshotHash(data.data) !== localHash) {
          snapshot = data.data;
          label = data.backup_date + ' 時点のバックアップ';
        }
      }
      if (!snapshot) { status('復元できるデータがありません。クラウドの内容は端末と一致しています。'); return; }
      if (!confirm(label + 'で現在の端末データを置き換えます。復元前に、現在の端末データは本日分のバックアップに保存します。よろしいですか？')) return;
      if (local) await writeBackupOnly(local);
      await restoreRemote(snapshot);
      setSyncMarker({ updatedAt: remote ? remote.updated_at : null, hash: snapshotHash(snapshot) });
      status('クラウドのデータを取り込みました。');
      location.reload();
    } catch (e) { console.error(e); status('復元できませんでした。端末内データは保持されています。'); }
    finally { busy = false; }
  }
  window.CloudSync = { init, login, logout, syncNow, schedule, restoreLatestBackup, isConfigured: () => configured };
})();
