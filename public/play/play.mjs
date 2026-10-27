// The archive's browser player: /play/?id=<game id>. The games run on gm-recomp
// (https://github.com/KurathSec/gm-recomp), whose player bundle is served at /play/gmr/
// (see README, "Play in the browser"). This page:
//  - starts only for a signed-in account allowed to play in the browser (users.play_access,
//    granted in the admin app; reported by /api/me);
//  - downloads the game from this origin (/api/play/file/…: the files host sends no
//    CORS headers; it serves those accounts alone) and imports it into this browser once,
//    keyed by the catalog id;
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
import { statesPanel } from './gmr/src/statepanel.mjs';

// ---- text ---------------------------------------------------------------------------------

const TEXT = {
  en: {
    back: '← Archive', loading: 'Loading…', step_info: 'Looking up the game…', step_cached: 'Loading the copy kept in this browser…',
    step_download: 'Downloading… {done} / {total} MB', step_import: 'Preparing the game…', step_saves: 'Getting your saves…', step_start: 'Starting…',
    dlg_ok: 'OK', dlg_cancel: 'Cancel', dlg_yes: 'Yes', dlg_no: 'No', dlg_ignore: 'Ignore', dlg_abort: 'Abort',
    sound_hint: 'Click or press a key to turn on sound', keys: 'Keys', saves: 'Saves', fullscreen: 'Fullscreen (F4)',
    sync_signin: 'Sign in to keep saves in your account', sync_ok: 'Saves kept in your account', sync_saving: 'Saving to your account…',
    sync_error: 'Saves not in your account: {error}', sync_local: 'Saves kept in this browser',
    err_title: 'This game could not start in the browser', err_nogame: 'There is no such game.', err_engine: 'The browser player does not run {engine} games.',
    err_stopped: 'The game stopped unexpectedly.', err_storage: 'This browser could not keep the game ({error}).', err_signin: 'Sign in to the archive to play in the browser.', err_access: 'Playing in the browser is open to selected accounts only.',
    btn_download: 'Download instead', btn_back: 'Back', btn_retry: 'Try again', btn_details: 'Details',
    choose_title: 'Which saves?', choose_about: 'This browser and your account have different saves of this game. Play with which one? The other is replaced.',
    choose_cloud: 'Your account\'s saves', choose_local: 'This browser\'s saves', choose_when: 'Last saved {when}',
    saves_title: 'Saves', saves_about: 'Saves are kept in this browser, and in your account when you are signed in.', saves_export: 'Export…', saves_import: 'Import…',
    saves_delete: 'Delete all saves', saves_close: 'Close', saves_none: 'This game has no saves yet.', saves_confirm_delete: 'Delete every save of this game (here and in your account) and restart it?',
    saves_confirm_import: 'Replace this game\'s saves with {file} and restart it?', saves_bad: 'Could not import: {error}',
    km_title: 'Keys', km_about: 'Keys you press here reach the game as other keys. The game itself is not changed.', km_game: 'Game key', km_yours: 'Your keys',
    km_add: 'Add', km_press: 'Press a key…', km_none: 'as it is', km_other: 'Another game key…', km_press_game: 'Press the game key…',
    km_this: 'This game only', km_all: 'Every game', km_reset: 'Reset', km_cancel: 'Cancel', km_save: 'Save',
    states: 'States', st_title: 'Save states', st_about: 'Kept in this browser only. {save} saves to the chosen slot, {load} goes back to it.', st_slot: 'Slot {n}', st_empty: 'Empty', st_save: 'Save', st_load: 'Load', st_delete: 'Delete', st_close: 'Close', st_saveKey: 'Save key', st_loadKey: 'Load key', st_press: 'Press a key…', st_saving: 'Saving to slot {n}…', st_saved: 'Saved to slot {n}', st_loading: 'Loading slot {n}…', st_loaded: 'Loaded slot {n}', st_failed: 'Slot {n}: {error}', st_isEmpty: 'Slot {n} is empty', st_notStored: 'Slot {n} could not be kept: {error}',
  },
  'zh-CN': {
    back: '← 返回 Archive', loading: '加载中…', step_info: '正在查找游戏…', step_cached: '正在载入本浏览器中保存的副本…',
    step_download: '下载中… {done} / {total} MB', step_import: '正在准备游戏…', step_saves: '正在获取你的存档…', step_start: '正在启动…',
    dlg_ok: '确定', dlg_cancel: '取消', dlg_yes: '是', dlg_no: '否', dlg_ignore: '忽略', dlg_abort: '中止',
    sound_hint: '点击或按任意键开启声音', keys: '按键', saves: '存档', fullscreen: '全屏 (F4)',
    sync_signin: '登录后可把存档保存在账户中', sync_ok: '存档已保存在你的账户中', sync_saving: '正在保存到账户…',
    sync_error: '存档未能保存到账户：{error}', sync_local: '存档保存在本浏览器中',
    err_title: '这个游戏无法在浏览器中启动', err_nogame: '没有这个游戏。', err_engine: '浏览器游玩不支持 {engine} 游戏。',
    err_stopped: '游戏意外停止了。', err_storage: '本浏览器无法保存游戏（{error}）。', err_signin: '请先登录档案馆再在浏览器中游玩。', err_access: '浏览器游玩仅对指定账户开放。',
    btn_download: '改为下载', btn_back: '返回', btn_retry: '重试', btn_details: '详细信息',
    choose_title: '使用哪份存档？', choose_about: '本浏览器和你的账户中有这个游戏的不同存档。要用哪一份来玩？另一份会被替换。',
    choose_cloud: '账户中的存档', choose_local: '本浏览器的存档', choose_when: '最后保存于 {when}',
    saves_title: '存档', saves_about: '存档保存在本浏览器中；登录后也会保存在你的账户中。', saves_export: '导出…', saves_import: '导入…',
    saves_delete: '删除全部存档', saves_close: '关闭', saves_none: '这个游戏还没有存档。', saves_confirm_delete: '删除这个游戏的所有存档（本浏览器和账户中）并重新开始？',
    saves_confirm_import: '用 {file} 替换这个游戏的存档并重新开始？', saves_bad: '无法导入：{error}',
    km_title: '按键', km_about: '在这里按下的键会以其他键的身份传给游戏。游戏本身不会被修改。', km_game: '游戏按键', km_yours: '你的按键',
    km_add: '添加', km_press: '请按一个键…', km_none: '不变', km_other: '其他游戏按键…', km_press_game: '请按要映射的游戏按键…',
    km_this: '仅这个游戏', km_all: '所有游戏', km_reset: '重置', km_cancel: '取消', km_save: '保存',
    states: '即时存档', st_title: '即时存档', st_about: '只保存在本浏览器中。{save} 保存到选中的栏位，{load} 回到它。', st_slot: '栏位 {n}', st_empty: '空', st_save: '保存', st_load: '读取', st_delete: '删除', st_close: '关闭', st_saveKey: '保存键', st_loadKey: '读取键', st_press: '请按一个键…', st_saving: '正在保存到栏位 {n}…', st_saved: '已保存到栏位 {n}', st_loading: '正在读取栏位 {n}…', st_loaded: '已读取栏位 {n}', st_failed: '栏位 {n}：{error}', st_isEmpty: '栏位 {n} 是空的', st_notStored: '栏位 {n} 未能保存：{error}',
  },
  'zh-TW': {
    back: '← 返回 Archive', loading: '載入中…', step_info: '正在查找遊戲…', step_cached: '正在載入本瀏覽器中保存的副本…',
    step_download: '下載中… {done} / {total} MB', step_import: '正在準備遊戲…', step_saves: '正在取得你的存檔…', step_start: '正在啟動…',
    dlg_ok: '確定', dlg_cancel: '取消', dlg_yes: '是', dlg_no: '否', dlg_ignore: '忽略', dlg_abort: '中止',
    sound_hint: '點擊或按任意鍵開啟聲音', keys: '按鍵', saves: '存檔', fullscreen: '全螢幕 (F4)',
    sync_signin: '登入後可把存檔保存在帳戶中', sync_ok: '存檔已保存在你的帳戶中', sync_saving: '正在保存到帳戶…',
    sync_error: '存檔未能保存到帳戶：{error}', sync_local: '存檔保存在本瀏覽器中',
    err_title: '這個遊戲無法在瀏覽器中啟動', err_nogame: '沒有這個遊戲。', err_engine: '瀏覽器遊玩不支援 {engine} 遊戲。',
    err_stopped: '遊戲意外停止了。', err_storage: '本瀏覽器無法保存遊戲（{error}）。', err_signin: '請先登入檔案館再在瀏覽器中遊玩。', err_access: '瀏覽器遊玩僅對指定帳戶開放。',
    btn_download: '改為下載', btn_back: '返回', btn_retry: '重試', btn_details: '詳細資訊',
    choose_title: '使用哪份存檔？', choose_about: '此瀏覽器和你的帳戶中有這個遊戲的不同存檔。要用哪一份來玩？另一份會被取代。',
    choose_cloud: '帳戶中的存檔', choose_local: '此瀏覽器的存檔', choose_when: '最後儲存於 {when}',
    saves_title: '存檔', saves_about: '存檔保存在本瀏覽器中；登入後也會保存在你的帳戶中。', saves_export: '匯出…', saves_import: '匯入…',
    saves_delete: '刪除全部存檔', saves_close: '關閉', saves_none: '這個遊戲還沒有存檔。', saves_confirm_delete: '刪除這個遊戲的所有存檔（本瀏覽器和帳戶中）並重新開始？',
    saves_confirm_import: '用 {file} 取代這個遊戲的存檔並重新開始？', saves_bad: '無法匯入：{error}',
    km_title: '按鍵', km_about: '在這裡按下的鍵會以其他鍵的身分傳給遊戲。遊戲本身不會被修改。', km_game: '遊戲按鍵', km_yours: '你的按鍵',
    km_add: '新增', km_press: '請按一個鍵…', km_none: '不變', km_other: '其他遊戲按鍵…', km_press_game: '請按要對應的遊戲按鍵…',
    km_this: '僅這個遊戲', km_all: '所有遊戲', km_reset: '重設', km_cancel: '取消', km_save: '保存',
    states: '即時存檔', st_title: '即時存檔', st_about: '只保存在本瀏覽器中。{save} 保存到選中的欄位，{load} 回到它。', st_slot: '欄位 {n}', st_empty: '空', st_save: '保存', st_load: '讀取', st_delete: '刪除', st_close: '關閉', st_saveKey: '保存鍵', st_loadKey: '讀取鍵', st_press: '請按一個鍵…', st_saving: '正在保存到欄位 {n}…', st_saved: '已保存到欄位 {n}', st_loading: '正在讀取欄位 {n}…', st_loaded: '已讀取欄位 {n}', st_failed: '欄位 {n}：{error}', st_isEmpty: '欄位 {n} 是空的', st_notStored: '欄位 {n} 未能保存：{error}',
  },
  ja: {
    back: '← Archive に戻る', loading: '読み込み中…', step_info: 'ゲームを探しています…', step_cached: 'このブラウザに保存したコピーを読み込んでいます…',
    step_download: 'ダウンロード中… {done} / {total} MB', step_import: 'ゲームを準備しています…', step_saves: 'セーブデータを取得しています…', step_start: '起動しています…',
    dlg_ok: 'OK', dlg_cancel: 'キャンセル', dlg_yes: 'はい', dlg_no: 'いいえ', dlg_ignore: '無視', dlg_abort: '中止',
    sound_hint: 'クリックかキーを押すと音が出ます', keys: 'キー', saves: 'セーブ', fullscreen: '全画面 (F4)',
    sync_signin: 'ログインするとセーブをアカウントに保存できます', sync_ok: 'セーブはアカウントに保存されています', sync_saving: 'アカウントに保存中…',
    sync_error: 'セーブをアカウントに保存できません: {error}', sync_local: 'セーブはこのブラウザに保存されています',
    err_title: 'このゲームはブラウザで起動できませんでした', err_nogame: 'そのゲームはありません。', err_engine: 'ブラウザ版は {engine} のゲームに対応していません。',
    err_stopped: 'ゲームが予期せず停止しました。', err_storage: 'このブラウザにゲームを保存できませんでした（{error}）。', err_signin: 'ブラウザでプレイするにはアーカイブにサインインしてください。', err_access: 'ブラウザ版は指定のアカウントのみ利用できます。',
    btn_download: '代わりにダウンロード', btn_back: '戻る', btn_retry: '再試行', btn_details: '詳細',
    choose_title: 'どちらのセーブを使いますか？', choose_about: 'このブラウザとアカウントに、このゲームの異なるセーブがあります。どちらで遊びますか？もう一方は置き換えられます。',
    choose_cloud: 'アカウントのセーブ', choose_local: 'このブラウザのセーブ', choose_when: '最終保存 {when}',
    saves_title: 'セーブ', saves_about: 'セーブはこのブラウザに、ログイン中はアカウントにも保存されます。', saves_export: '書き出し…', saves_import: '読み込み…',
    saves_delete: 'すべてのセーブを削除', saves_close: '閉じる', saves_none: 'このゲームのセーブはまだありません。', saves_confirm_delete: 'このゲームのセーブをすべて（このブラウザとアカウントから）削除して再起動しますか？',
    saves_confirm_import: 'このゲームのセーブを {file} で置き換えて再起動しますか？', saves_bad: '読み込めませんでした: {error}',
    km_title: 'キー', km_about: 'ここで押したキーは別のキーとしてゲームに届きます。ゲーム自体は変更されません。', km_game: 'ゲームのキー', km_yours: 'あなたのキー',
    km_add: '追加', km_press: 'キーを押してください…', km_none: 'そのまま', km_other: '別のゲームのキー…', km_press_game: 'ゲームのキーを押してください…',
    km_this: 'このゲームのみ', km_all: 'すべてのゲーム', km_reset: 'リセット', km_cancel: 'キャンセル', km_save: '保存',
    states: 'ステート', st_title: 'ステートセーブ', st_about: 'このブラウザにだけ保存されます。{save} で選んだスロットに保存、{load} でそこへ戻ります。', st_slot: 'スロット {n}', st_empty: '空', st_save: '保存', st_load: '読込', st_delete: '削除', st_close: '閉じる', st_saveKey: '保存キー', st_loadKey: '読込キー', st_press: 'キーを押してください…', st_saving: 'スロット {n} に保存中…', st_saved: 'スロット {n} に保存しました', st_loading: 'スロット {n} を読込中…', st_loaded: 'スロット {n} を読み込みました', st_failed: 'スロット {n}：{error}', st_isEmpty: 'スロット {n} は空です', st_notStored: 'スロット {n} を保存できませんでした：{error}',
  },
  ko: {
    back: '← Archive로 돌아가기', loading: '불러오는 중…', step_info: '게임을 찾는 중…', step_cached: '이 브라우저에 저장된 사본을 불러오는 중…',
    step_download: '다운로드 중… {done} / {total} MB', step_import: '게임을 준비하는 중…', step_saves: '세이브를 가져오는 중…', step_start: '시작하는 중…',
    dlg_ok: '확인', dlg_cancel: '취소', dlg_yes: '예', dlg_no: '아니요', dlg_ignore: '무시', dlg_abort: '중단',
    sound_hint: '클릭하거나 키를 누르면 소리가 켜집니다', keys: '키', saves: '세이브', fullscreen: '전체 화면 (F4)',
    sync_signin: '로그인하면 세이브를 계정에 보관할 수 있습니다', sync_ok: '세이브가 계정에 보관되어 있습니다', sync_saving: '계정에 저장하는 중…',
    sync_error: '세이브를 계정에 저장하지 못했습니다: {error}', sync_local: '세이브가 이 브라우저에 보관되어 있습니다',
    err_title: '이 게임은 브라우저에서 시작할 수 없습니다', err_nogame: '그런 게임이 없습니다.', err_engine: '브라우저 플레이는 {engine} 게임을 지원하지 않습니다.',
    err_stopped: '게임이 예기치 않게 멈췄습니다.', err_storage: '이 브라우저에 게임을 보관할 수 없습니다({error}).', err_signin: '브라우저에서 플레이하려면 아카이브에 로그인하세요.', err_access: '브라우저 플레이는 지정된 계정에만 열려 있습니다.',
    btn_download: '대신 다운로드', btn_back: '뒤로', btn_retry: '다시 시도', btn_details: '자세히',
    choose_title: '어느 세이브를 사용할까요?', choose_about: '이 브라우저와 계정에 이 게임의 서로 다른 세이브가 있습니다. 어느 쪽으로 플레이할까요? 다른 쪽은 대체됩니다.',
    choose_cloud: '계정의 세이브', choose_local: '이 브라우저의 세이브', choose_when: '마지막 저장 {when}',
    saves_title: '세이브', saves_about: '세이브는 이 브라우저에, 로그인했다면 계정에도 보관됩니다.', saves_export: '내보내기…', saves_import: '가져오기…',
    saves_delete: '모든 세이브 삭제', saves_close: '닫기', saves_none: '이 게임에는 아직 세이브가 없습니다.', saves_confirm_delete: '이 게임의 모든 세이브를 (이 브라우저와 계정에서) 삭제하고 다시 시작할까요?',
    saves_confirm_import: '이 게임의 세이브를 {file}(으)로 바꾸고 다시 시작할까요?', saves_bad: '가져오지 못했습니다: {error}',
    km_title: '키', km_about: '여기서 누른 키는 다른 키로 게임에 전달됩니다. 게임 자체는 바뀌지 않습니다.', km_game: '게임 키', km_yours: '내 키',
    km_add: '추가', km_press: '키를 누르세요…', km_none: '그대로', km_other: '다른 게임 키…', km_press_game: '게임 키를 누르세요…',
    km_this: '이 게임만', km_all: '모든 게임', km_reset: '초기화', km_cancel: '취소', km_save: '저장',
    states: '스테이트', st_title: '세이브 스테이트', st_about: '이 브라우저에만 저장됩니다. {save}로 선택한 슬롯에 저장하고 {load}로 돌아갑니다.', st_slot: '슬롯 {n}', st_empty: '비어 있음', st_save: '저장', st_load: '불러오기', st_delete: '삭제', st_close: '닫기', st_saveKey: '저장 키', st_loadKey: '불러오기 키', st_press: '키를 누르세요…', st_saving: '슬롯 {n}에 저장 중…', st_saved: '슬롯 {n}에 저장했습니다', st_loading: '슬롯 {n} 불러오는 중…', st_loaded: '슬롯 {n}을(를) 불러왔습니다', st_failed: '슬롯 {n}: {error}', st_isEmpty: '슬롯 {n}이(가) 비어 있습니다', st_notStored: '슬롯 {n}을(를) 저장하지 못했습니다: {error}',
  },
  ru: {
    back: '← В Archive', loading: 'Загрузка…', step_info: 'Ищем игру…', step_cached: 'Загружаем копию из этого браузера…',
    step_download: 'Скачивание… {done} / {total} МБ', step_import: 'Подготовка игры…', step_saves: 'Получаем ваши сохранения…', step_start: 'Запуск…',
    dlg_ok: 'ОК', dlg_cancel: 'Отмена', dlg_yes: 'Да', dlg_no: 'Нет', dlg_ignore: 'Пропустить', dlg_abort: 'Прервать',
    sound_hint: 'Щёлкните или нажмите клавишу, чтобы включить звук', keys: 'Клавиши', saves: 'Сохранения', fullscreen: 'Во весь экран (F4)',
    sync_signin: 'Войдите, чтобы хранить сохранения в аккаунте', sync_ok: 'Сохранения хранятся в аккаунте', sync_saving: 'Сохраняем в аккаунт…',
    sync_error: 'Сохранения не попали в аккаунт: {error}', sync_local: 'Сохранения хранятся в этом браузере',
    err_title: 'Эту игру не удалось запустить в браузере', err_nogame: 'Такой игры нет.', err_engine: 'Браузерный плеер не запускает игры на {engine}.',
    err_stopped: 'Игра неожиданно остановилась.', err_storage: 'Этот браузер не смог сохранить игру ({error}).', err_signin: 'Войдите в архив, чтобы играть в браузере.', err_access: 'Игра в браузере доступна только избранным аккаунтам.',
    btn_download: 'Скачать', btn_back: 'Назад', btn_retry: 'Повторить', btn_details: 'Подробности',
    choose_title: 'Какие сохранения?', choose_about: 'В этом браузере и в вашем аккаунте разные сохранения этой игры. С какими играть? Другие будут заменены.',
    choose_cloud: 'Сохранения аккаунта', choose_local: 'Сохранения этого браузера', choose_when: 'Сохранено {when}',
    saves_title: 'Сохранения', saves_about: 'Сохранения хранятся в этом браузере, а после входа — и в аккаунте.', saves_export: 'Экспорт…', saves_import: 'Импорт…',
    saves_delete: 'Удалить все сохранения', saves_close: 'Закрыть', saves_none: 'У этой игры пока нет сохранений.', saves_confirm_delete: 'Удалить все сохранения этой игры (здесь и в аккаунте) и перезапустить её?',
    saves_confirm_import: 'Заменить сохранения этой игры файлом {file} и перезапустить её?', saves_bad: 'Не удалось импортировать: {error}',
    km_title: 'Клавиши', km_about: 'Клавиши, которые вы нажимаете, доходят до игры как другие. Сама игра не меняется.', km_game: 'Клавиша игры', km_yours: 'Ваши клавиши',
    km_add: 'Добавить', km_press: 'Нажмите клавишу…', km_none: 'как есть', km_other: 'Другая клавиша игры…', km_press_game: 'Нажмите клавишу игры…',
    km_this: 'Только эта игра', km_all: 'Все игры', km_reset: 'Сбросить', km_cancel: 'Отмена', km_save: 'Сохранить',
    states: 'Состояния', st_title: 'Сохранения состояния', st_about: 'Хранятся только в этом браузере. {save} сохраняет в выбранный слот, {load} возвращает к нему.', st_slot: 'Слот {n}', st_empty: 'Пусто', st_save: 'Сохранить', st_load: 'Загрузить', st_delete: 'Удалить', st_close: 'Закрыть', st_saveKey: 'Клавиша сохранения', st_loadKey: 'Клавиша загрузки', st_press: 'Нажмите клавишу…', st_saving: 'Сохранение в слот {n}…', st_saved: 'Сохранено в слот {n}', st_loading: 'Загрузка слота {n}…', st_loaded: 'Слот {n} загружен', st_failed: 'Слот {n}: {error}', st_isEmpty: 'Слот {n} пуст', st_notStored: 'Слот {n} не удалось сохранить: {error}',
  },
  fr: {
    back: '← Retour à l\'Archive', loading: 'Chargement…', step_info: 'Recherche du jeu…', step_cached: 'Chargement de la copie gardée dans ce navigateur…',
    step_download: 'Téléchargement… {done} / {total} Mo', step_import: 'Préparation du jeu…', step_saves: 'Récupération de vos sauvegardes…', step_start: 'Démarrage…',
    dlg_ok: 'OK', dlg_cancel: 'Annuler', dlg_yes: 'Oui', dlg_no: 'Non', dlg_ignore: 'Ignorer', dlg_abort: 'Abandonner',
    sound_hint: 'Cliquez ou appuyez sur une touche pour activer le son', keys: 'Touches', saves: 'Sauvegardes', fullscreen: 'Plein écran (F4)',
    sync_signin: 'Connectez-vous pour garder vos sauvegardes dans votre compte', sync_ok: 'Sauvegardes gardées dans votre compte', sync_saving: 'Envoi vers votre compte…',
    sync_error: 'Sauvegardes absentes du compte : {error}', sync_local: 'Sauvegardes gardées dans ce navigateur',
    err_title: 'Ce jeu n\'a pas pu démarrer dans le navigateur', err_nogame: 'Ce jeu n\'existe pas.', err_engine: 'Le lecteur du navigateur ne lance pas les jeux {engine}.',
    err_stopped: 'Le jeu s\'est arrêté de façon inattendue.', err_storage: 'Ce navigateur n\'a pas pu garder le jeu ({error}).', err_signin: 'Connectez-vous à l\'archive pour jouer dans le navigateur.', err_access: 'Le jeu dans le navigateur est réservé à certains comptes.',
    btn_download: 'Télécharger plutôt', btn_back: 'Retour', btn_retry: 'Réessayer', btn_details: 'Détails',
    choose_title: 'Quelles sauvegardes ?', choose_about: 'Ce navigateur et votre compte ont des sauvegardes différentes de ce jeu. Avec lesquelles jouer ? Les autres seront remplacées.',
    choose_cloud: 'Sauvegardes du compte', choose_local: 'Sauvegardes de ce navigateur', choose_when: 'Enregistré le {when}',
    saves_title: 'Sauvegardes', saves_about: 'Les sauvegardes sont gardées dans ce navigateur, et dans votre compte si vous êtes connecté.', saves_export: 'Exporter…', saves_import: 'Importer…',
    saves_delete: 'Supprimer toutes les sauvegardes', saves_close: 'Fermer', saves_none: 'Ce jeu n\'a pas encore de sauvegarde.', saves_confirm_delete: 'Supprimer toutes les sauvegardes de ce jeu (ici et dans votre compte) et le redémarrer ?',
    saves_confirm_import: 'Remplacer les sauvegardes de ce jeu par {file} et le redémarrer ?', saves_bad: 'Import impossible : {error}',
    km_title: 'Touches', km_about: 'Les touches que vous pressez ici arrivent au jeu comme d\'autres touches. Le jeu lui-même n\'est pas modifié.', km_game: 'Touche du jeu', km_yours: 'Vos touches',
    km_add: 'Ajouter', km_press: 'Appuyez sur une touche…', km_none: 'inchangée', km_other: 'Autre touche du jeu…', km_press_game: 'Appuyez sur la touche du jeu…',
    km_this: 'Ce jeu seulement', km_all: 'Tous les jeux', km_reset: 'Réinitialiser', km_cancel: 'Annuler', km_save: 'Enregistrer',
    states: 'États', st_title: 'Sauvegardes d’état', st_about: 'Gardées dans ce navigateur seulement. {save} enregistre dans l’emplacement choisi, {load} y revient.', st_slot: 'Emplacement {n}', st_empty: 'Vide', st_save: 'Enregistrer', st_load: 'Charger', st_delete: 'Supprimer', st_close: 'Fermer', st_saveKey: 'Touche d’enregistrement', st_loadKey: 'Touche de chargement', st_press: 'Appuyez sur une touche…', st_saving: 'Enregistrement dans l’emplacement {n}…', st_saved: 'Enregistré dans l’emplacement {n}', st_loading: 'Chargement de l’emplacement {n}…', st_loaded: 'Emplacement {n} chargé', st_failed: 'Emplacement {n} : {error}', st_isEmpty: 'L’emplacement {n} est vide', st_notStored: 'L’emplacement {n} n’a pas pu être gardé : {error}',
  },
  de: {
    back: '← Zurück zum Archive', loading: 'Wird geladen…', step_info: 'Spiel wird gesucht…', step_cached: 'Die in diesem Browser gespeicherte Kopie wird geladen…',
    step_download: 'Download… {done} / {total} MB', step_import: 'Spiel wird vorbereitet…', step_saves: 'Deine Spielstände werden geholt…', step_start: 'Wird gestartet…',
    dlg_ok: 'OK', dlg_cancel: 'Abbrechen', dlg_yes: 'Ja', dlg_no: 'Nein', dlg_ignore: 'Ignorieren', dlg_abort: 'Abbrechen',
    sound_hint: 'Klicke oder drücke eine Taste, um den Ton einzuschalten', keys: 'Tasten', saves: 'Spielstände', fullscreen: 'Vollbild (F4)',
    sync_signin: 'Melde dich an, um Spielstände im Konto zu behalten', sync_ok: 'Spielstände im Konto gespeichert', sync_saving: 'Wird im Konto gespeichert…',
    sync_error: 'Spielstände nicht im Konto: {error}', sync_local: 'Spielstände in diesem Browser gespeichert',
    err_title: 'Dieses Spiel konnte im Browser nicht starten', err_nogame: 'Dieses Spiel gibt es nicht.', err_engine: 'Der Browser-Player startet keine {engine}-Spiele.',
    err_stopped: 'Das Spiel wurde unerwartet beendet.', err_storage: 'Dieser Browser konnte das Spiel nicht speichern ({error}).', err_signin: 'Melde dich im Archiv an, um im Browser zu spielen.', err_access: 'Spielen im Browser ist nur für ausgewählte Konten freigegeben.',
    btn_download: 'Stattdessen herunterladen', btn_back: 'Zurück', btn_retry: 'Erneut versuchen', btn_details: 'Details',
    choose_title: 'Welche Spielstände?', choose_about: 'Dieser Browser und dein Konto haben verschiedene Spielstände dieses Spiels. Mit welchen spielen? Die anderen werden ersetzt.',
    choose_cloud: 'Spielstände im Konto', choose_local: 'Spielstände in diesem Browser', choose_when: 'Zuletzt gespeichert {when}',
    saves_title: 'Spielstände', saves_about: 'Spielstände werden in diesem Browser gespeichert und, wenn du angemeldet bist, auch in deinem Konto.', saves_export: 'Exportieren…', saves_import: 'Importieren…',
    saves_delete: 'Alle Spielstände löschen', saves_close: 'Schließen', saves_none: 'Dieses Spiel hat noch keine Spielstände.', saves_confirm_delete: 'Alle Spielstände dieses Spiels (hier und im Konto) löschen und neu starten?',
    saves_confirm_import: 'Die Spielstände dieses Spiels durch {file} ersetzen und neu starten?', saves_bad: 'Import nicht möglich: {error}',
    km_title: 'Tasten', km_about: 'Tasten, die du hier drückst, kommen beim Spiel als andere Tasten an. Das Spiel selbst wird nicht verändert.', km_game: 'Spieltaste', km_yours: 'Deine Tasten',
    km_add: 'Hinzufügen', km_press: 'Drücke eine Taste…', km_none: 'unverändert', km_other: 'Weitere Spieltaste…', km_press_game: 'Drücke die Spieltaste…',
    km_this: 'Nur dieses Spiel', km_all: 'Alle Spiele', km_reset: 'Zurücksetzen', km_cancel: 'Abbrechen', km_save: 'Speichern',
    states: 'Zustände', st_title: 'Spielzustände', st_about: 'Nur in diesem Browser gespeichert. {save} speichert im gewählten Platz, {load} kehrt dorthin zurück.', st_slot: 'Platz {n}', st_empty: 'Leer', st_save: 'Speichern', st_load: 'Laden', st_delete: 'Löschen', st_close: 'Schließen', st_saveKey: 'Speichertaste', st_loadKey: 'Ladetaste', st_press: 'Drücke eine Taste…', st_saving: 'Speichere in Platz {n}…', st_saved: 'In Platz {n} gespeichert', st_loading: 'Lade Platz {n}…', st_loaded: 'Platz {n} geladen', st_failed: 'Platz {n}: {error}', st_isEmpty: 'Platz {n} ist leer', st_notStored: 'Platz {n} konnte nicht gespeichert werden: {error}',
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
const PLAYABLE = { 'GameMaker 8': true, 'GameMaker: Studio': true, 'GameMaker: Studio 2': true };

for (const [el, key] of [['back', 'back'], ['keys', 'keys'], ['saves', 'saves'], ['states', 'states'], ['fs', 'fullscreen'], ['hint', 'sound_hint']]) $(el).textContent = t(key);
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

async function download(url, size, token) {
  const r = await fetch(fileUrl(url), { headers: { Authorization: `Bearer ${token}` } });
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

// (gm8: a GameMaker 8 runner of another build, or packed; it runs without mods)
const runnable = (e) => e && (e.kind === 'gm80' || e.kind === 'gm81' || e.kind === 'gm8' || e.kind === 'gms');

/** The game, imported into this browser (once per catalog file); `token` is the account's. */
async function ensureImported(db, game, token) {
  const key = new URL(game.url).pathname;
  const kept = await loadGame(db, slug).catch(() => null);
  if (kept?.manifest?.source_key === key && kept.manifest.source_size === game.size) {
    status(t('step_cached'), { progress: null });
    noteLocal(kept.files);
    return kept.manifest;
  }
  const bytes = await download(game.url, game.size, token);
  status(t('step_import'), { progress: null });
  const name = decodeURIComponent(key.split('/').pop() || 'game.zip');
  const { manifest, files } = await importArchive(bytes, name, (text) => status(t('step_import'), { progress: null, detail: text }));
  if (!runnable(manifest.engine)) {
    const e = manifest.engine?.kind ?? '?';
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
  noteLocal(files);
  return manifest;
}

/** The archive's Local games list (src/play.jsx): this game's stored size, played now. */
function noteLocal(files) {
  const bytes = (files ?? []).reduce((n, f) => n + (f?.[1]?.byteLength ?? 0), 0);
  const meta = store.get('fa.local', {});
  meta[id] = { bytes, at: Date.now() };
  store.set('fa.local', meta);
}

/**
 * Browser play is open to whitelisted accounts only (users.play_access, granted in the admin
 * app; the game files are served to them alone): the signed-in account's token when it may
 * play, else the reason it may not (an error shown).
 */
async function playToken(clerk) {
  if (!clerk) throw Object.assign(new Error(t('err_signin')), { shown: true });
  const token = await clerk.session.getToken();
  const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  if (!data.user) throw Object.assign(new Error(t('err_signin')), { shown: true });
  if (!data.user.play_access) throw Object.assign(new Error(t('err_access')), { shown: true });
  return token;
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
  /**
   * Before the game starts: the account's saves against this browser's. When both have saves
   * and they differ, the player chooses if this browser never synced with the account or both
   * changed since they last did; otherwise the side that changed wins (the account's when only
   * it did, this browser's when only it did: it goes up).
   */
  async pull(remote) {
    if (!this.clerk) {
      this.show('', t('sync_signin'), `/?game=${id}`);
      return;
    }
    status(t('step_saves'), { progress: null });
    const { save } = await remote;
    const local = await loadSaves(this.db, slug);
    const hasLocal = local.some((s) => s.data);
    if (save) {
      const cloud = parseSaves(save.data, slug);
      const remote = this.state.remote || 0;
      if (!hasLocal || sameSaves(local, cloud)) {
        if (hasLocal) this.state = { ...this.state, remote: save.updated_at, dirty: false };
        else await this.take(save, cloud);
      } else if (remote === 0 || (save.updated_at > remote && this.state.dirty)) {
        const localAt = this.state.localAt || Math.max(0, ...local.map((s) => s.mtime || 0));
        if ((await chooseSaves(save.updated_at, localAt)) === 'cloud') await this.take(save, cloud);
        else this.state.dirty = true;
      } else if (save.updated_at > remote) await this.take(save, cloud);
      this.keep();
    } else if (hasLocal) {
      // saves from before signing in
      this.state.dirty = true;
    }
    this.show('ok', t('sync_ok'));
    if (this.state.dirty) this.schedule(0);
  },
  /** The account's saves replace this browser's. */
  async take(save, cloud) {
    await deleteSaves(this.db, slug);
    await storeSaves(this.db, slug, cloud);
    this.state = { remote: save.updated_at, dirty: false };
    this.keep();
  },
  /** Saves changed (the game wrote them): into the account shortly. */
  changed() {
    this.state.dirty = true;
    this.state.localAt = Date.now();
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
        this.state = { remote: updated_at, dirty: false, localAt: this.state.localAt };
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
  const access = clerk.then(playToken);
  access.catch(() => {});
  // The account's saves are asked for while the game downloads and imports, so they are
  // usually there by the time it can start.
  const remote = access.then(() => clerk).then((c) => {
    sync.clerk = c;
    return sync.api('GET');
  });
  remote.catch(() => {});
  let game = null;
  try {
    game = await gameRecord();
    if (!game) return fail(t('err_nogame'));
    $('title').textContent = game.title;
    document.title = `${game.title} — Fangame Archive`;
    status(t('step_info'), { title: game.title, progress: null });
    if (game.engine && !PLAYABLE[game.engine]) return fail(t('err_engine', { engine: game.engine }), game);
    // (also a game this browser kept: it does not start for an account without access)
    const token = await access;
    const db = await openSaves();
    sync.db = db;
    await ensureImported(db, game, token);
    sync.clerk = await clerk;
    await sync.pull(remote).catch((e) => sync.show('error', t('sync_error', { error: e.message ?? e })));
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
  // the Save states mod (chosen in the game's drawer): states kept in this browser, a panel
  // over the game (gm-recomp's statepanel.mjs)
  // (a game whose own mod choices were never set starts from the defaults, the archive's
  // My Content › Settings: src/play.jsx DEFAULT_MODS_KEY)
  const modChoices = localStorage.getItem(`gmr.mods.${slug}`) === null ? store.get('fa.mods.defaults', {}) : loadChoices(slug);
  const saveStates = !!modChoices.SaveStates?.on;
  // (the Save states mod's instant load: a second copy of the game waits at the state)
  const instantLoad = saveStates && !!modChoices.SaveStates?.config?.instantLoad;
  let statesUi = null;
  const player = playGame({
    game: slug,
    local: true,
    canvas: screen,
    modChoices,
    saveStates,
    instantLoad,
    onStateStored: (n, error) => statesUi?.stored(n, error),
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
    onPrompt: gameDialog,
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
  if (saveStates) {
    const keys = ['title', 'about', 'slot', 'empty', 'save', 'load', 'delete', 'close', 'saveKey', 'loadKey', 'press', 'saving', 'saved', 'loading', 'loaded', 'failed', 'isEmpty', 'notStored'];
    statesUi = statesPanel({ player, game: slug, mount: $('stage'), labels: Object.fromEntries(keys.map((k) => [k, t('st_' + k)])) });
    $('states').hidden = false;
    $('states').onclick = () => statesUi.toggle();
  }
}

// ---- choosing saves -----------------------------------------------------------------------

/** The same saved files (paths and contents; their times aside). */
function sameSaves(a, b) {
  const files = (list) => {
    const m = new Map();
    for (const s of list) if (s.data) m.set(s.path.toLowerCase(), s.data);
    return m;
  };
  const x = files(a);
  const y = files(b);
  if (x.size !== y.size) return false;
  for (const [p, d] of x) {
    const e = y.get(p);
    if (!e || e.length !== d.length) return false;
    for (let i = 0; i < d.length; i++) if (d[i] !== e[i]) return false;
  }
  return true;
}

/**
 * A dialog the game opened (GameMaker 8's show_message, show_question, get_string...), in
 * the page instead of the browser's own: it stays in full screen, and the key that closes it
 * does not reach the game. Resolves to the text typed, '' for OK or Yes, null for Cancel
 * or No; Escape is Cancel/No (OK for a message), as on Windows.
 */
function gameDialog({ title, text, def, kind }) {
  return new Promise((resolve) => {
    const dlg = $('gamedlg');
    dlg.replaceChildren();
    const form = document.createElement('form');
    form.method = 'dialog';
    const el = (tag, content) => Object.assign(document.createElement(tag), { textContent: content });
    if (title) form.append(el('h2', title));
    const body = el('p', text);
    body.className = 'game-text';
    form.append(body);
    let input = null;
    if (kind === 'error') body.classList.add('game-error');
    if (kind === 'text') {
      input = Object.assign(document.createElement('input'), { type: 'text', value: def ?? '', className: 'game-input' });
      form.append(input);
    }
    const buttons = document.createElement('div');
    buttons.className = 'dlg-buttons';
    const button = (value, label, primary) => {
      const b = el('button', label);
      b.type = 'submit';
      b.value = value;
      if (primary) b.className = 'primary';
      return b;
    };
    // ('error': GameMaker 8's runtime error, Ignore goes on, Abort ends the game, as on Windows)
    const ok = button('ok', kind === 'question' ? t('dlg_yes') : kind === 'error' ? t('dlg_ignore') : t('dlg_ok'), true);
    if (kind === 'question') buttons.append(ok, button('no', t('dlg_no')));
    else if (kind === 'error') buttons.append(ok, button('no', t('dlg_abort')));
    else if (kind === 'text') buttons.append(ok, button('no', t('dlg_cancel')));
    else buttons.append(ok);
    form.append(buttons);
    // Enter in the text field is OK
    form.onsubmit = (ev) => {
      if (ev.submitter == null) {
        ev.preventDefault();
        dlg.close('ok');
      }
    };
    dlg.append(form);
    dlg.oncancel = (ev) => {
      ev.preventDefault();
      dlg.close(kind === 'message' ? 'ok' : 'no');
    };
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? (input ? input.value : '') : null);
    dlg.returnValue = '';
    dlg.showModal();
    (input ?? ok).focus();
    input?.select();
  });
}

/** Asks which saves to play with: 'cloud' or 'local'. */
function chooseSaves(cloudAt, localAt) {
  return new Promise((resolve) => {
    const dlg = $('choosedlg');
    dlg.replaceChildren();
    const form = document.createElement('form');
    form.method = 'dialog';
    const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
    const when = (ms) => (ms > 0 ? new Date(ms).toLocaleString(lang) : '—');
    const option = (value, label, at) => {
      const b = document.createElement('button');
      b.type = 'submit';
      b.value = value;
      b.className = 'choose-opt';
      b.append(el('b', label), el('span', t('choose_when', { when: when(at) })));
      return b;
    };
    const list = document.createElement('div');
    list.className = 'choose-list';
    list.append(option('cloud', t('choose_cloud'), cloudAt), option('local', t('choose_local'), localAt));
    form.append(el('h2', t('choose_title')), el('p', t('choose_about')), list);
    dlg.append(form);
    // a choice is needed: Escape does not close it
    dlg.oncancel = (ev) => ev.preventDefault();
    dlg.onclose = () => resolve(dlg.returnValue === 'local' ? 'local' : 'cloud');
    dlg.showModal();
  });
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
