(function(){
  const config = window.HOME_ORGANIZER_SUPABASE || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || '') &&
    !!config.anonKey && !String(config.anonKey).includes('YOUR_');
  let client = null, user = null, busy = false, suppress = false, timer = null;
  const status = (message) => {
    const el = document.getElementById('cloudSyncStatus');
    if (el) el.textContent = message;
  };
  const authButtons = () => {
    const login = document.getElementById('cloudLoginButton');
    const logout = document.getElementById('cloudLogoutButton');
    const sync = document.getElementById('cloudSyncButton');
    if (login) login.classList.toggle('hidden', !!user || !configured);
    if (logout) logout.classList.toggle('hidden', !user);
    if (sync) sync.classList.toggle('hidden', !user);
  };
  async function init(){
    if (!configured || !window.supabase || !window.supabase.createClient) {
      status('クラウド同期は未設定です。Supabaseプロジェクトの設定が必要です。端末内の保存とJSONバックアップは引き続き利用できます。');
      authButtons(); return;
    }
    client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data: sessionData } = await client.auth.getSession();
    user = sessionData && sessionData.session ? sessionData.session.user : null;
    authButtons();
    status(user ? 'Googleアカウントに接続済みです。同期状態を確認しています。' : '未ログインです。端末内データはこの端末に保存されています。');
    client.auth.onAuthStateChange((event, session) => {
      user = session && session.user ? session.user : null;
      authButtons();
      if (user && event === 'SIGNED_IN') setTimeout(() => onSignedIn(), 0);
      if (!user) status('ログアウトしました。端末内のデータは削除していません。');
    });
    if (user) await onSignedIn();
  }
  async function login(){
    if (!client) { status('クラウド設定が未完了です。'); return; }
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.href.split('#')[0] }
    });
    if (error) { console.error(error); status('Googleログインを開始できませんでした。Supabaseの認証設定を確認してください。'); }
  }
  async function logout(){
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) { console.error(error); status('ログアウトできませんでした。'); }
    else { user = null; authButtons(); status('ログアウトしました。端末内のデータは削除していません。'); }
  }
  function getLocalData(){ return window.HomeOrganizerGetData ? window.HomeOrganizerGetData() : null; }
  function getPhoto(id){ return window.HomeOrganizerGetPhoto ? window.HomeOrganizerGetPhoto(id) : Promise.resolve(''); }
  async function getPhotoRefs(snapshot){
    return [...(snapshot.items || []), ...(snapshot.locations || [])].map(x => x.photo).filter(x => x && String(x).startsWith('photo:'));
  }
  async function uploadPhotos(snapshot){
    const refs = [...new Set(await getPhotoRefs(snapshot))];
    for (const ref of refs) {
      const value = await getPhoto(ref);
      if (!value || !String(value).startsWith('data:')) throw new Error('端末内の写真が見つかりません: ' + ref);
      const response = await fetch(value);
      const blob = await response.blob();
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/gif' ? 'gif' : 'jpg';
      const path = user.id + '/' + encodeURIComponent(ref) + '.' + ext;
      const { error } = await client.storage.from('home-organizer-photos').upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
      if (error) throw error;
    }
  }
  async function saveSnapshot(snapshot, createDailyBackup){
    await uploadPhotos(snapshot);
    const { error } = await client.from('home_organizer_data').upsert({ user_id: user.id, data: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    if (createDailyBackup) {
      const today = new Date().toISOString().slice(0,10);
      const { error: backupError } = await client.from('home_organizer_backups').upsert({ user_id: user.id, backup_date: today, data: snapshot }, { onConflict: 'user_id,backup_date' });
      if (backupError) console.warn('Daily backup could not be written', backupError);
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
  async function onSignedIn(){
    if (!client || !user || busy) return;
    busy = true; status('クラウドのデータを確認しています…');
    try {
      const remote = await fetchRemote();
      const local = getLocalData();
      if (!remote) {
        await saveSnapshot(local, true);
        status('初回バックアップを作成しました。自動同期が有効です。');
      } else {
        const chooseRemote = confirm('このGoogleアカウントにはクラウドデータがあります。\nOK：クラウドのデータをこの端末へ復元\nキャンセル：この端末のデータでクラウドを更新');
        if (chooseRemote) {
          await restoreRemote(remote.data);
          status('クラウドのデータを復元しました。');
        } else {
          await saveSnapshot(local, true);
          status('この端末のデータをクラウドへ保存しました。');
        }
      }
    } catch (e) {
      console.error('Cloud sync initialization failed', e);
      status('同期に失敗しました。通信・Supabase設定・保存容量を確認してください。端末内データは保持されています。');
    } finally { busy = false; }
  }
  async function syncNow(){
    if (!client || !user || busy) return;
    busy = true; status('同期中…');
    try { await saveSnapshot(getLocalData(), true); status('同期・バックアップが完了しました。'); }
    catch (e) { console.error(e); status('同期できませんでした。端末内データは保持されています。'); }
    finally { busy = false; }
  }
  function schedule(snapshot){
    if (!client || !user || suppress) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy) { schedule(snapshot); return; }
      busy = true; status('変更をクラウドへ同期しています…');
      try { await saveSnapshot(snapshot, false); status('クラウドへ同期済みです。'); }
      catch (e) { console.error('Automatic sync failed', e); status('自動同期に失敗しました。通信回復後に「今すぐ同期」を押してください。'); }
      finally { busy = false; }
    }, 900);
  }
  async function restoreLatestBackup(){
    if (!client || !user) return;
    const { data, error } = await client.from('home_organizer_backups').select('backup_date,data').eq('user_id', user.id).order('backup_date', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) { status('利用できるクラウドバックアップがありません。'); return; }
    if (!confirm(data.backup_date + ' 時点のバックアップで現在の端末データを置き換えます。先に端末内バックアップを書き出しましたか？')) return;
    try { await restoreRemote(data.data); status('クラウドバックアップを復元しました。'); location.reload(); }
    catch (e) { console.error(e); status('バックアップを復元できませんでした。'); }
  }
  window.CloudSync = { init, login, logout, syncNow, schedule, restoreLatestBackup, isConfigured: () => configured };
})();