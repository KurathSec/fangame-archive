// The archive's browser player: /play/?id=<game id>. The games run on gm-recomp
// (https://github.com/KurathSec/gm-recomp), whose player bundle is served at /play/gmr/
// (see README, "Play in the browser"). This page:
//  - downloads the game from this origin (/api/play/file/…: the files host sends no
//    CORS headers) and imports it into this browser once, keyed by the catalog id;
//  - applies the mods chosen in the game's drawer (src/play.jsx) and the player's key map;
//  - keeps the game's saves in the player's account when they are signed in
//    (/api/saves/:id), and in this browser either way;
//  - goes back to the archive when the game ends (a game's Esc usually quits it).
// It is cross-origin isolated (COOP/COEP, see _headers), which the player needs.

import { playGame } from './gmr/src/player.mjs';
import { importArchive } from './gmr/src/import.mjs';
import { deleteSaves, exportSaves, loadGame, loadSaves, openSaves, parseSaves, storeGame, storeSaves } from './gmr/src/saves.mjs';
import { loadChoices } from './gmr/src/mods.mjs';
import { editKeymap, loadKeymap } from './gmr/src/keymap.mjs';

// ---- text ---------------------------------------------------------------------------------

const TEXT = {
  en: {
    back: '← Archive', loading: 'Loading…', step_info: 'Looking up the game…', step_cached: 'Loading the copy kept in this browser…',
    step_download: 'Downloading… {done} / {total} MB', step_import: 'Preparing the game…', step_saves: 'Getting your saves…', step_start: 'Starting…',
    sound_hint: 'Click or press a key to turn on sound', keys: 'Keys', saves: 'Saves', fullscreen: 'Fullscreen (F4)',
    sync_signin: 'Sign in to keep saves in your account', sync_ok: 'Saves kept in your account', sync_saving: 'Saving to your account…',
    sync_error: 'Saves not in your account: {error}', sync_local: 'Saves kept in this browser',
    err_title: 'This game could not start in the browser', err_nogame: 'There is no such game.', err_engine: 'The browser player does not run {engine} games.',
    err_stopped: 'The game stopped unexpectedly.', err_storage: 'This browser could not keep the game ({error}).',
    btn_download: 'Download instead', btn_back: 'Back', btn_retry: 'Try again', btn_details: 'Details',
    conflict: 'Your account has newer saves of this game from another browser. Use them?\n(Cancel keeps the saves in this browser and puts them in your account.)',
    saves_title: 'Saves', saves_about: 'Saves are kept in this browser, and in your account when you are signed in.', saves_export: 'Export…', saves_import: 'Import…',
    saves_delete: 'Delete all saves', saves_close: 'Close', saves_none: 'This game has no saves yet.', saves_confirm_delete: 'Delete every save of this game (here and in your account) and restart it?',
    saves_confirm_import: 'Replace this game\'s saves with {file} and restart it?', saves_bad: 'Could not import: {error}',
    km_title: 'Keys', km_about: 'Keys you press here reach the game as other keys. The game itself is not changed.', km_game: 'Game key', km_yours: 'Your keys',
    km_add: 'Add', km_press: 'Press a key…', km_none: 'as it is', km_other: 'Another game key…', km_press_game: 'Press the game key…',
    km_this: 'This game only', km_all: 'Every game', km_reset: 'Reset', km_cancel: 'Cancel', km_save: 'Save',
  },
  'zh-CN': {
    back: '← 返回 Archive', loading: '加载中…', step_info: '正在查找游戏…', step_cached: '正在载入本浏览器中保存的副本…',
    step_download: '下载中… {done} / {total} MB', step_import: '正在准备游戏…', step_saves: '正在获取你的存档…', step_start: '正在启动…',
    sound_hint: '点击或按任意键开启声音', keys: '按键', saves: '存档', fullscreen: '全屏 (F4)',
    sync_signin: '登录后可把存档保存在账户中', sync_ok: '存档已保存在你的账户中', sync_saving: '正在保存到账户…',
    sync_error: '存档未能保存到账户：{error}', sync_local: '存档保存在本浏览器中',
    err_title: '这个游戏无法在浏览器中启动', err_nogame: '没有这个游戏。', err_engine: '浏览器游玩不支持 {engine} 游戏。',
    err_stopped: '游戏意外停止了。', err_storage: '本浏览器无法保存游戏（{error}）。',
    btn_download: '改为下载', btn_back: '返回', btn_retry: '重试', btn_details: '详细信息',
    conflict: '你的账户里有这个游戏来自其他浏览器的更新存档。要使用它们吗？\n（取消则保留本浏览器的存档，并上传到账户。）',
    saves_title: '存档', saves_about: '存档保存在本浏览器中；登录后也会保存在你的账户中。', saves_export: '导出…', saves_import: '导入…',
    saves_delete: '删除全部存档', saves_close: '关闭', saves_none: '这个游戏还没有存档。', saves_confirm_delete: '删除这个游戏的所有存档（本浏览器和账户中）并重新开始？',
    saves_confirm_import: '用 {file} 替换这个游戏的存档并重新开始？', saves_bad: '无法导入：{error}',
    km_title: '按键', km_about: '在这里按下的键会以其他键的身份传给游戏。游戏本身不会被修改。', km_game: '游戏按键', km_yours: '你的按键',
    km_add: '添加', km_press: '请按一个键…', km_none: '不变', km_other: '其他游戏按键…', km_press_game: '请按要映射的游戏按键…',
    km_this: '仅这个游戏', km_all: '所有游戏', km_reset: '重置', km_cancel: '取消', km_save: '保存',
  },
  'zh-TW': {
    back: '← 返回 Archive', loading: '載入中…', step_info: '正在查找遊戲…', step_cached: '正在載入本瀏覽器中保存的副本…',
    step_download: '下載中… {done} / {total} MB', step_import: '正在準備遊戲…', step_saves: '正在取得你的存檔…', step_start: '正在啟動…',
    sound_hint: '點擊或按任意鍵開啟聲音', keys: '按鍵', saves: '存檔', fullscreen: '全螢幕 (F4)',
    sync_signin: '登入後可把存檔保存在帳戶中', sync_ok: '存檔已保存在你的帳戶中', sync_saving: '正在保存到帳戶…',
    sync_error: '存檔未能保存到帳戶：{error}', sync_local: '存檔保存在本瀏覽器中',
    err_title: '這個遊戲無法在瀏覽器中啟動', err_nogame: '沒有這個遊戲。', err_engine: '瀏覽器遊玩不支援 {engine} 遊戲。',
    err_stopped: '遊戲意外停止了。', err_storage: '本瀏覽器無法保存遊戲（{error}）。',
    btn_download: '改為下載', btn_back: '返回', btn_retry: '重試', btn_details: '詳細資訊',
    conflict: '你的帳戶裡有這個遊戲來自其他瀏覽器的較新存檔。要使用它們嗎？\n（取消則保留本瀏覽器的存檔，並上傳到帳戶。）',
    saves_title: '存檔', saves_about: '存檔保存在本瀏覽器中；登入後也會保存在你的帳戶中。', saves_export: '匯出…', saves_import: '匯入…',
    saves_delete: '刪除全部存檔', saves_close: '關閉', saves_none: '這個遊戲還沒有存檔。', saves_confirm_delete: '刪除這個遊戲的所有存檔（本瀏覽器和帳戶中）並重新開始？',
    saves_confirm_import: '用 {file} 取代這個遊戲的存檔並重新開始？', saves_bad: '無法匯入：{error}',
    km_title: '按鍵', km_about: '在這裡按下的鍵會以其他鍵的身分傳給遊戲。遊戲本身不會被修改。', km_game: '遊戲按鍵', km_yours: '你的按鍵',
    km_add: '新增', km_press: '請按一個鍵…', km_none: '不變', km_other: '其他遊戲按鍵…', km_press_game: '請按要對應的遊戲按鍵…',
    km_this: '僅這個遊戲', km_all: '所有遊戲', km_reset: '重設', km_cancel: '取消', km_save: '保存',
  },
  ja: {
    back: '← Archive に戻る', loading: '読み込み中…', step_info: 'ゲームを探しています…', step_cached: 'このブラウザに保存したコピーを読み込んでいます…',
    step_download: 'ダウンロード中… {done} / {total} MB', step_import: 'ゲームを準備しています…', step_saves: 'セーブデータを取得しています…', step_start: '起動しています…',
    sound_hint: 'クリックかキーを押すと音が出ます', keys: 'キー', saves: 'セーブ', fullscreen: '全画面 (F4)',
    sync_signin: 'ログインするとセーブをアカウントに保存できます', sync_ok: 'セーブはアカウントに保存されています', sync_saving: 'アカウントに保存中…',
    sync_error: 'セーブをアカウントに保存できません: {error}', sync_local: 'セーブはこのブラウザに保存されています',
    err_title: 'このゲームはブラウザで起動できませんでした', err_nogame: 'そのゲームはありません。', err_engine: 'ブラウザ版は {engine} のゲームに対応していません。',
    err_stopped: 'ゲームが予期せず停止しました。', err_storage: 'このブラウザにゲームを保存できませんでした（{error}）。',
    btn_download: '代わりにダウンロード', btn_back: '戻る', btn_retry: '再試行', btn_details: '詳細',
    conflict: 'アカウントに、別のブラウザで保存したこのゲームの新しいセーブがあります。使いますか？\n（キャンセルするとこのブラウザのセーブを残し、アカウントに保存します。）',
    saves_title: 'セーブ', saves_about: 'セーブはこのブラウザに、ログイン中はアカウントにも保存されます。', saves_export: '書き出し…', saves_import: '読み込み…',
    saves_delete: 'すべてのセーブを削除', saves_close: '閉じる', saves_none: 'このゲームのセーブはまだありません。', saves_confirm_delete: 'このゲームのセーブをすべて（このブラウザとアカウントから）削除して再起動しますか？',
    saves_confirm_import: 'このゲームのセーブを {file} で置き換えて再起動しますか？', saves_bad: '読み込めませんでした: {error}',
    km_title: 'キー', km_about: 'ここで押したキーは別のキーとしてゲームに届きます。ゲーム自体は変更されません。', km_game: 'ゲームのキー', km_yours: 'あなたのキー',
    km_add: '追加', km_press: 'キーを押してください…', km_none: 'そのまま', km_other: '別のゲームのキー…', km_press_game: 'ゲームのキーを押してください…',
    km_this: 'このゲームのみ', km_all: 'すべてのゲーム', km_reset: 'リセット', km_cancel: 'キャンセル', km_save: '保存',
  },
  ko: {
    back: '← Archive로 돌아가기', loading: '불러오는 중…', step_info: '게임을 찾는 중…', step_cached: '이 브라우저에 저장된 사본을 불러오는 중…',
    step_download: '다운로드 중… {done} / {total} MB', step_import: '게임을 준비하는 중…', step_saves: '세이브를 가져오는 중…', step_start: '시작하는 중…',
    sound_hint: '클릭하거나 키를 누르면 소리가 켜집니다', keys: '키', saves: '세이브', fullscreen: '전체 화면 (F4)',
    sync_signin: '로그인하면 세이브를 계정에 보관할 수 있습니다', sync_ok: '세이브가 계정에 보관되어 있습니다', sync_saving: '계정에 저장하는 중…',
    sync_error: '세이브를 계정에 저장하지 못했습니다: {error}', sync_local: '세이브가 이 브라우저에 보관되어 있습니다',
    err_title: '이 게임은 브라우저에서 시작할 수 없습니다', err_nogame: '그런 게임이 없습니다.', err_engine: '브라우저 플레이는 {engine} 게임을 지원하지 않습니다.',
    err_stopped: '게임이 예기치 않게 멈췄습니다.', err_storage: '이 브라우저에 게임을 보관할 수 없습니다({error}).',
    btn_download: '대신 다운로드', btn_back: '뒤로', btn_retry: '다시 시도', btn_details: '자세히',
    conflict: '계정에 다른 브라우저에서 저장한 이 게임의 더 새로운 세이브가 있습니다. 사용할까요?\n(취소하면 이 브라우저의 세이브를 유지하고 계정에 저장합니다.)',
    saves_title: '세이브', saves_about: '세이브는 이 브라우저에, 로그인했다면 계정에도 보관됩니다.', saves_export: '내보내기…', saves_import: '가져오기…',
    saves_delete: '모든 세이브 삭제', saves_close: '닫기', saves_none: '이 게임에는 아직 세이브가 없습니다.', saves_confirm_delete: '이 게임의 모든 세이브를 (이 브라우저와 계정에서) 삭제하고 다시 시작할까요?',
    saves_confirm_import: '이 게임의 세이브를 {file}(으)로 바꾸고 다시 시작할까요?', saves_bad: '가져오지 못했습니다: {error}',
    km_title: '키', km_about: '여기서 누른 키는 다른 키로 게임에 전달됩니다. 게임 자체는 바뀌지 않습니다.', km_game: '게임 키', km_yours: '내 키',
    km_add: '추가', km_press: '키를 누르세요…', km_none: '그대로', km_other: '다른 게임 키…', km_press_game: '게임 키를 누르세요…',
    km_this: '이 게임만', km_all: '모든 게임', km_reset: '초기화', km_cancel: '취소', km_save: '저장',
  },
  ru: {
    back: '← В Archive', loading: 'Загрузка…', step_info: 'Ищем игру…', step_cached: 'Загружаем копию из этого браузера…',
    step_download: 'Скачивание… {done} / {total} МБ', step_import: 'Подготовка игры…', step_saves: 'Получаем ваши сохранения…', step_start: 'Запуск…',
    sound_hint: 'Щёлкните или нажмите клавишу, чтобы включить звук', keys: 'Клавиши', saves: 'Сохранения', fullscreen: 'Во весь экран (F4)',
    sync_signin: 'Войдите, чтобы хранить сохранения в аккаунте', sync_ok: 'Сохранения хранятся в аккаунте', sync_saving: 'Сохраняем в аккаунт…',
    sync_error: 'Сохранения не попали в аккаунт: {error}', sync_local: 'Сохранения хранятся в этом браузере',
    err_title: 'Эту игру не удалось запустить в браузере', err_nogame: 'Такой игры нет.', err_engine: 'Браузерный плеер не запускает игры на {engine}.',
    err_stopped: 'Игра неожиданно остановилась.', err_storage: 'Этот браузер не смог сохранить игру ({error}).',
    btn_download: 'Скачать', btn_back: 'Назад', btn_retry: 'Повторить', btn_details: 'Подробности',
    conflict: 'В вашем аккаунте есть более новые сохранения этой игры из другого браузера. Использовать их?\n(Отмена оставит сохранения этого браузера и отправит их в аккаунт.)',
    saves_title: 'Сохранения', saves_about: 'Сохранения хранятся в этом браузере, а после входа — и в аккаунте.', saves_export: 'Экспорт…', saves_import: 'Импорт…',
    saves_delete: 'Удалить все сохранения', saves_close: 'Закрыть', saves_none: 'У этой игры пока нет сохранений.', saves_confirm_delete: 'Удалить все сохранения этой игры (здесь и в аккаунте) и перезапустить её?',
    saves_confirm_import: 'Заменить сохранения этой игры файлом {file} и перезапустить её?', saves_bad: 'Не удалось импортировать: {error}',
    km_title: 'Клавиши', km_about: 'Клавиши, которые вы нажимаете, доходят до игры как другие. Сама игра не меняется.', km_game: 'Клавиша игры', km_yours: 'Ваши клавиши',
    km_add: 'Добавить', km_press: 'Нажмите клавишу…', km_none: 'как есть', km_other: 'Другая клавиша игры…', km_press_game: 'Нажмите клавишу игры…',
    km_this: 'Только эта игра', km_all: 'Все игры', km_reset: 'Сбросить', km_cancel: 'Отмена', km_save: 'Сохранить',
  },
  fr: {
    back: '← Retour à l\'Archive', loading: 'Chargement…', step_info: 'Recherche du jeu…', step_cached: 'Chargement de la copie gardée dans ce navigateur…',
    step_download: 'Téléchargement… {done} / {total} Mo', step_import: 'Préparation du jeu…', step_saves: 'Récupération de vos sauvegardes…', step_start: 'Démarrage…',
    sound_hint: 'Cliquez ou appuyez sur une touche pour activer le son', keys: 'Touches', saves: 'Sauvegardes', fullscreen: 'Plein écran (F4)',
    sync_signin: 'Connectez-vous pour garder vos sauvegardes dans votre compte', sync_ok: 'Sauvegardes gardées dans votre compte', sync_saving: 'Envoi vers votre compte…',
    sync_error: 'Sauvegardes absentes du compte : {error}', sync_local: 'Sauvegardes gardées dans ce navigateur',
    err_title: 'Ce jeu n\'a pas pu démarrer dans le navigateur', err_nogame: 'Ce jeu n\'existe pas.', err_engine: 'Le lecteur du navigateur ne lance pas les jeux {engine}.',
    err_stopped: 'Le jeu s\'est arrêté de façon inattendue.', err_storage: 'Ce navigateur n\'a pas pu garder le jeu ({error}).',
    btn_download: 'Télécharger plutôt', btn_back: 'Retour', btn_retry: 'Réessayer', btn_details: 'Détails',
    conflict: 'Votre compte a des sauvegardes plus récentes de ce jeu venant d\'un autre navigateur. Les utiliser ?\n(Annuler garde les sauvegardes de ce navigateur et les envoie dans votre compte.)',
    saves_title: 'Sauvegardes', saves_about: 'Les sauvegardes sont gardées dans ce navigateur, et dans votre compte si vous êtes connecté.', saves_export: 'Exporter…', saves_import: 'Importer…',
    saves_delete: 'Supprimer toutes les sauvegardes', saves_close: 'Fermer', saves_none: 'Ce jeu n\'a pas encore de sauvegarde.', saves_confirm_delete: 'Supprimer toutes les sauvegardes de ce jeu (ici et dans votre compte) et le redémarrer ?',
    saves_confirm_import: 'Remplacer les sauvegardes de ce jeu par {file} et le redémarrer ?', saves_bad: 'Import impossible : {error}',
    km_title: 'Touches', km_about: 'Les touches que vous pressez ici arrivent au jeu comme d\'autres touches. Le jeu lui-même n\'est pas modifié.', km_game: 'Touche du jeu', km_yours: 'Vos touches',
    km_add: 'Ajouter', km_press: 'Appuyez sur une touche…', km_none: 'inchangée', km_other: 'Autre touche du jeu…', km_press_game: 'Appuyez sur la touche du jeu…',
    km_this: 'Ce jeu seulement', km_all: 'Tous les jeux', km_reset: 'Réinitialiser', km_cancel: 'Annuler', km_save: 'Enregistrer',
  },
  de: {
    back: '← Zurück zum Archive', loading: 'Wird geladen…', step_info: 'Spiel wird gesucht…', step_cached: 'Die in diesem Browser gespeicherte Kopie wird geladen…',
    step_download: 'Download… {done} / {total} MB', step_import: 'Spiel wird vorbereitet…', step_saves: 'Deine Spielstände werden geholt…', step_start: 'Wird gestartet…',
    sound_hint: 'Klicke oder drücke eine Taste, um den Ton einzuschalten', keys: 'Tasten', saves: 'Spielstände', fullscreen: 'Vollbild (F4)',
    sync_signin: 'Melde dich an, um Spielstände im Konto zu behalten', sync_ok: 'Spielstände im Konto gespeichert', sync_saving: 'Wird im Konto gespeichert…',
    sync_error: 'Spielstände nicht im Konto: {error}', sync_local: 'Spielstände in diesem Browser gespeichert',
    err_title: 'Dieses Spiel konnte im Browser nicht starten', err_nogame: 'Dieses Spiel gibt es nicht.', err_engine: 'Der Browser-Player startet keine {engine}-Spiele.',
    err_stopped: 'Das Spiel wurde unerwartet beendet.', err_storage: 'Dieser Browser konnte das Spiel nicht speichern ({error}).',
    btn_download: 'Stattdessen herunterladen', btn_back: 'Zurück', btn_retry: 'Erneut versuchen', btn_details: 'Details',
    conflict: 'Dein Konto hat neuere Spielstände dieses Spiels aus einem anderen Browser. Diese verwenden?\n(Abbrechen behält die Spielstände dieses Browsers und speichert sie im Konto.)',
    saves_title: 'Spielstände', saves_about: 'Spielstände werden in diesem Browser gespeichert und, wenn du angemeldet bist, auch in deinem Konto.', saves_export: 'Exportieren…', saves_import: 'Importieren…',
    saves_delete: 'Alle Spielstände löschen', saves_close: 'Schließen', saves_none: 'Dieses Spiel hat noch keine Spielstände.', saves_confirm_delete: 'Alle Spielstände dieses Spiels (hier und im Konto) löschen und neu starten?',
    saves_confirm_import: 'Die Spielstände dieses Spiels durch {file} ersetzen und neu starten?', saves_bad: 'Import nicht möglich: {error}',
    km_title: 'Tasten', km_about: 'Tasten, die du hier drückst, kommen beim Spiel als andere Tasten an. Das Spiel selbst wird nicht verändert.', km_game: 'Spieltaste', km_yours: 'Deine Tasten',
    km_add: 'Hinzufügen', km_press: 'Drücke eine Taste…', km_none: 'unverändert', km_other: 'Weitere Spieltaste…', km_press_game: 'Drücke die Spieltaste…',
    km_this: 'Nur dieses Spiel', km_all: 'Alle Spiele', km_reset: 'Zurücksetzen', km_cancel: 'Abbrechen', km_save: 'Speichern',
  },
};
let lang = 'en';
try {
  lang = localStorage.getItem('fangame_archive_lang') || 'en';
} catch {}
const t = (key, params = {}) => {
  let s = (TEXT[lang] ?? TEXT.en)[key] ?? TEXT.en[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);
  return s;
};
document.documentElement.lang = lang;

// ---- small helpers ------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const store = {
  get(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null') ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const id = Number(new URLSearchParams(location.search).get('id'));
const slug = `fa-${id}`;
const PLAYABLE = { 'GameMaker 8': true, 'GameMaker: Studio': true };

for (const [el, key] of [['back', 'back'], ['keys', 'keys'], ['saves', 'saves'], ['fs', 'fullscreen'], ['hint', 'sound_hint']]) $(el).textContent = t(key);
$('back').href = `/?game=${id}`;

/** Back to where the game was started from (the archive with its drawer open). */
function back() {
  let same = false;
  try {
    same = !!document.referrer && new URL(document.referrer).origin === location.origin;
  } catch {}
  if (same && history.length > 1) history.back();
  else location.href = `/?game=${id}`;
}
$('back').addEventListener('click', (e) => {
  e.preventDefault();
  sync.flush().finally(back);
});

// ---- status panel -------------------------------------------------------------------------

const logLines = [];
function status(step, { title, progress, detail } = {}) {
  $('status').hidden = false;
  $('status').classList.remove('error');
  if (title !== undefined) $('status-title').textContent = title;
  $('status-step').textContent = step;
  const bar = $('status-bar');
  bar.hidden = progress === undefined;
  if (progress === null) bar.removeAttribute('value');
  else if (progress !== undefined) bar.value = progress;
  $('status-detail').textContent = detail ?? '';
}

function fail(message, game) {
  status(message, { title: t('err_title') });
  $('status').classList.add('error');
  const actions = $('status-actions');
  actions.replaceChildren();
  actions.hidden = false;
  const button = (text, f, primary) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (primary) b.className = 'primary';
    b.onclick = f;
    actions.append(b);
    return b;
  };
  button(t('btn_back'), back, true);
  button(t('btn_retry'), () => location.reload());
  if (game?.url) {
    const a = document.createElement('a');
    a.className = 'button';
    a.href = game.url;
    a.rel = 'noopener';
    a.textContent = t('btn_download');
    actions.append(a);
  }
  if (logLines.length) button(t('btn_details'), () => ($('status-detail').textContent = logLines.slice(-12).join('\n')));
}

// ---- the game's record --------------------------------------------------------------------

async function gameRecord() {
  // the drawer leaves it here before coming (src/play.jsx); a link from elsewhere asks the API
  const handed = store.get(`fa.play.${id}`, null);
  if (handed?.url) return handed;
  const r = await fetch(`/api/search?id=${id}`);
  if (!r.ok) return null;
  const data = await r.json();
  const list = Array.isArray(data) ? data : (data.results ?? data.games ?? []);
  const g = list.find((x) => Number(x.id) === id) ?? null;
  return g && { id, title: g.title, url: g.url, engine: g.engine ?? null, size: g.file_size ?? 0 };
}

/** The game file's path on this origin: the files host's path, served by /api/play/file/. */
function fileUrl(url) {
  const u = new URL(url);
  return `/api/play/file${u.pathname}`;
}

async function download(url, size) {
  const r = await fetch(fileUrl(url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || size || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let done = 0;
  const mb = (n) => (n / 1048576).toFixed(1);
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    status(t('step_download', { done: mb(done), total: total ? mb(total) : '?' }), { progress: total ? done / total : null });
  }
  const bytes = new Uint8Array(done);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

const runnable = (e) => e && (e.kind === 'gm80' || e.kind === 'gm81' || (e.kind === 'gms' && (e.version?.[0] ?? 1) < 2));

/** The game, imported into this browser (once per catalog file). */
async function ensureImported(db, game) {
  const key = new URL(game.url).pathname;
  const kept = await loadGame(db, slug).catch(() => null);
  if (kept?.manifest?.source_key === key && kept.manifest.source_size === game.size) {
    status(t('step_cached'), { progress: null });
    return kept.manifest;
  }
  const bytes = await download(game.url, game.size);
  status(t('step_import'), { progress: null });
  const name = decodeURIComponent(key.split('/').pop() || 'game.zip');
  const { manifest, files } = await importArchive(bytes, name, (text) => status(t('step_import'), { progress: null, detail: text }));
  if (!runnable(manifest.engine)) {
    const e = manifest.engine?.kind === 'gms' ? 'GameMaker Studio 2' : (manifest.engine?.kind ?? '?');
    throw Object.assign(new Error(t('err_engine', { engine: e })), { shown: true });
  }
  manifest.slug = slug;
  manifest.title = game.title || manifest.title;
  manifest.source_key = key;
  manifest.source_size = game.size;
  try {
    await storeGame(db, slug, { manifest, files });
  } catch (e) {
    throw Object.assign(new Error(t('err_storage', { error: e.message ?? e })), { shown: true });
  }
  return manifest;
}

// ---- account saves ------------------------------------------------------------------------

/** Clerk (the archive's sign-in), or null when it does not load or nobody is signed in. */
function loadClerk() {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = window.CLERK_JS_URL;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.setAttribute('data-clerk-publishable-key', window.CLERK_PUBLISHABLE_KEY);
    s.onload = async () => {
      try {
        if (typeof window.Clerk === 'function') window.Clerk = new window.Clerk(window.CLERK_PUBLISHABLE_KEY);
        await window.Clerk.load({ publishableKey: window.CLERK_PUBLISHABLE_KEY });
        resolve(window.Clerk.session ? window.Clerk : null);
      } catch {
        resolve(null);
      }
    };
    s.onerror = () => resolve(null);
    document.head.append(s);
    setTimeout(() => resolve(null), 8000);
  });
}

const sync = {
  clerk: null,
  db: null,
  timer: 0,
  pending: null,
  // {remote: updated_at last taken from or put in the account, dirty: changed since}
  state: store.get(`fa.saves.${id}`, { remote: 0, dirty: false }),
  keep() {
    store.set(`fa.saves.${id}`, this.state);
  },
  show(cls, text, link) {
    const el = $('sync');
    el.hidden = false;
    el.className = cls;
    el.replaceChildren();
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.textContent = text;
      el.append(a);
    } else el.textContent = text;
  },
  async api(method, body) {
    const token = await this.clerk.session.getToken();
    const r = await fetch(`/api/saves/${id}`, { method, body, headers: { Authorization: `Bearer ${token}` }, keepalive: method === 'PUT' && body.length < 60000 });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  /** Before the game starts: takes the account's saves when they are newer. */
  async pull() {
    if (!this.clerk) {
      this.show('', t('sync_signin'), `/?game=${id}`);
      return;
    }
    status(t('step_saves'), { progress: null });
    const { save } = await this.api('GET');
    const local = await loadSaves(this.db, slug);
    if (save && save.updated_at > (this.state.remote || 0)) {
      const hasLocal = local.some((s) => s.data);
      if (!(this.state.dirty && hasLocal) || confirm(t('conflict'))) {
        await deleteSaves(this.db, slug);
        await storeSaves(this.db, slug, parseSaves(save.data, slug));
        this.state = { remote: save.updated_at, dirty: false };
        this.keep();
      }
    } else if (!save && local.some((s) => s.data)) {
      // saves from before signing in
      this.state.dirty = true;
    }
    this.show('ok', t('sync_ok'));
    if (this.state.dirty) this.schedule(0);
  },
  /** Saves changed (the game wrote them): into the account shortly. */
  changed() {
    this.state.dirty = true;
    this.keep();
    if (this.clerk) this.schedule(1500);
  },
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), ms);
  },
  push() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.pending = (this.pending ?? Promise.resolve()).then(async () => {
      if (!this.clerk || !this.state.dirty) return;
      this.show('', t('sync_saving'));
      try {
        const text = exportSaves(slug, await loadSaves(this.db, slug));
        const { updated_at } = await this.api('PUT', text);
        this.state = { remote: updated_at, dirty: false };
        this.keep();
        this.show('ok', t('sync_ok'));
      } catch (e) {
        this.show('error', t('sync_error', { error: e.message ?? e }));
      }
    });
    return this.pending;
  },
  /** Anything not yet in the account, now (leaving the page). */
  flush() {
    if (this.timer || (this.clerk && this.state.dirty)) return Promise.race([this.push(), new Promise((r) => setTimeout(r, 3000))]);
    return Promise.resolve();
  },
};
addEventListener('pagehide', () => sync.flush());

// ---- playing ------------------------------------------------------------------------------

/** The archive's Playing list (src/play.jsx): this game, played now. */
function markPlaying() {
  const list = store.get('fa.playing', []).filter((e) => e && e.id !== id);
  list.unshift({ id, at: Date.now() });
  store.set('fa.playing', list.slice(0, 50));
  const hidden = store.get('fa.playing.hidden', []);
  if (hidden.includes(id)) store.set('fa.playing.hidden', hidden.filter((x) => x !== id));
}

async function main() {
  if (!id) return fail(t('err_nogame'));
  if (!self.crossOriginIsolated) return fail('cross-origin isolation is off (COOP/COEP headers)');
  status(t('step_info'), { title: t('loading'), progress: null });
  const clerk = loadClerk();
  let game = null;
  try {
    game = await gameRecord();
    if (!game) return fail(t('err_nogame'));
    $('title').textContent = game.title;
    document.title = `${game.title} — Fangame Archive`;
    status(t('step_info'), { title: game.title, progress: null });
    if (game.engine && !PLAYABLE[game.engine]) return fail(t('err_engine', { engine: game.engine }), game);
    const db = await openSaves();
    sync.db = db;
    await ensureImported(db, game);
    sync.clerk = await clerk;
    await sync.pull().catch((e) => sync.show('error', t('sync_error', { error: e.message ?? e })));
    if (!sync.clerk) sync.show('', t('sync_signin'), `/?game=${id}`);
  } catch (e) {
    logLines.push(String(e?.stack ?? e));
    return fail(e.shown ? e.message : `${e.message ?? e}`, game);
  }
  status(t('step_start'), { progress: null });
  markPlaying();
  start(game);
}

function start(game) {
  const screen = $('screen');
  let gameW = 640, gameH = 480;
  const fit = () => {
    const stage = $('stage').getBoundingClientRect();
    let s = Math.min(stage.width / gameW, stage.height / gameH);
    if (s >= 1) s = Math.floor(s);
    screen.style.width = `${Math.max(1, Math.round(gameW * s))}px`;
    screen.style.height = `${Math.max(1, Math.round(gameH * s))}px`;
  };
  addEventListener('resize', fit);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.();
  };
  $('fs').onclick = toggleFullscreen;
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
    requestAnimationFrame(fit);
  });
  fit();
  let started = false;
  const player = playGame({
    game: slug,
    local: true,
    canvas: screen,
    modChoices: loadChoices(slug),
    keymap: loadKeymap(slug).map,
    // F4 is the browser's full screen: a game's own switch only resizes its window here
    pageKeys: { F4: toggleFullscreen },
    onLog(line) {
      logLines.push(line);
      if (logLines.length > 200) logLines.shift();
    },
    onSoundPending: (waiting) => ($('hint').hidden = !waiting),
    onSize(w, h) {
      [gameW, gameH] = [w, h];
      started = true;
      $('status').hidden = true;
      fit();
    },
    onSaved: () => sync.changed(),
    async onDone(status) {
      if (status === 0) {
        // the game quit (Esc in most fangames): back to the archive, saves first
        await sync.flush();
        back();
      } else {
        fail(started ? t('err_stopped') : String(logLines.at(-1) ?? t('err_stopped')), game);
      }
    },
  });
  $('keys').disabled = false;
  $('keys').onclick = async () => {
    const labels = {
      title: t('km_title'), about: t('km_about'), gameKey: t('km_game'), yourKeys: t('km_yours'), add: t('km_add'), press: t('km_press'),
      none: t('km_none'), other: t('km_other'), pressGame: t('km_press_game'), thisGame: t('km_this'), allGames: t('km_all'),
      reset: t('km_reset'), cancel: t('km_cancel'), save: t('km_save'),
    };
    const r = await editKeymap($('keysdlg'), slug, labels);
    if (r) player.setKeymap(r.map);
  };
  $('saves').disabled = false;
  $('saves').onclick = () => savesDialog(game);
}

// ---- saves dialog -------------------------------------------------------------------------

function savesDialog(game) {
  const dlg = $('savesdlg');
  dlg.replaceChildren();
  const form = document.createElement('form');
  form.method = 'dialog';
  const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const button = (text, f) => {
    const b = el('button', text);
    b.type = 'button';
    b.onclick = f;
    return b;
  };
  const list = document.createElement('div');
  list.className = 'dlg-list';
  const exportBtn = button(t('saves_export'), async () => {
    const saves = await loadSaves(sync.db, slug);
    if (!saves.some((s) => s.data)) return alert(t('saves_none'));
    const url = URL.createObjectURL(new Blob([exportSaves(slug, saves)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `${game.title || slug}-saves.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json', hidden: true });
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const entries = parseSaves(await f.text(), slug);
      if (!confirm(t('saves_confirm_import', { file: f.name }))) return;
      await deleteSaves(sync.db, slug);
      await storeSaves(sync.db, slug, entries);
      sync.state.dirty = true;
      sync.keep();
      await sync.flush();
      location.reload();
    } catch (e) {
      alert(t('saves_bad', { error: e.message ?? e }));
    }
  };
  const importBtn = button(t('saves_import'), () => file.click());
  const deleteBtn = button(t('saves_delete'), async () => {
    if (!confirm(t('saves_confirm_delete'))) return;
    await deleteSaves(sync.db, slug);
    if (sync.clerk) await sync.api('DELETE').catch(() => {});
    sync.state = { remote: 0, dirty: false };
    sync.keep();
    location.reload();
  });
  const row = (...items) => {
    const d = document.createElement('div');
    d.append(...items);
    return d;
  };
  list.append(row(exportBtn, importBtn), row(deleteBtn));
  const buttons = document.createElement('div');
  buttons.className = 'dlg-buttons';
  const close = el('button', t('saves_close'));
  close.value = 'close';
  buttons.append(close);
  form.append(el('h2', t('saves_title')), el('p', t('saves_about')), list, file, buttons);
  dlg.append(form);
  dlg.showModal();
}

main();
