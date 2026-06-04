<?php
/**
 * Educaty — lead-forwarder для Timeweb / Beget / любого хостинга с PHP
 * -----------------------------------------------------------------
 * Принимает POST {name, phone, form, page, ts, utm} от формы лендинга,
 * раскладывает заявку в Telegram-чат и (опционально) в amoCRM.
 *
 * Установка:
 *  1) Откройте этот файл и заполните CONFIG ниже (токен бота, chat_id).
 *  2) Загрузите файл рядом с index.html на хостинг (например в public_html/).
 *  3) В index.html константу LEAD_ENDPOINT поставьте на:
 *       const LEAD_ENDPOINT = "/lead-forwarder.php";
 *  4) Готово — заявки пойдут в Telegram.
 *
 * Требования: PHP 7.0+ (есть на любом тарифе Timeweb / Beget), функция
 * curl_init() включена по умолчанию.
 */

// ===================== CONFIG =====================
$CONFIG = [
    // Токен из @BotFather, например 8647124207:AAE0aaDjGo96xoGPeSjbFC2J9tm2n2-5JeU
    'telegram_bot_token' => 'PUT_YOUR_BOT_TOKEN_HERE',

    // chat_id, куда бот пишет — личка (положит. число) или группа/канал (-100...)
    'telegram_chat_id'   => 'PUT_YOUR_CHAT_ID_HERE',

    // (опционально) URL входящего вебхука amoCRM. Оставьте пустым, если не нужно.
    'amocrm_webhook_url' => '',

    // Домены, с которых принимаем форму. '*' — отовсюду (для теста ок).
    // На бою укажите явно: 'https://educaty.com,https://www.educaty.com'
    'allowed_origin'     => '*',
];
// ==================================================

header('Content-Type: application/json; charset=utf-8');

// ---------- CORS ----------
$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
$allow  = '*';
if ($CONFIG['allowed_origin'] !== '*') {
    $allowed_list = array_map('trim', explode(',', $CONFIG['allowed_origin']));
    if (in_array($origin, $allowed_list, true)) {
        $allow = $origin;
    } else {
        // ставим первый из списка как дефолт, чтобы preflight всё-таки прошёл
        $allow = $allowed_list[0];
    }
}
header('Access-Control-Allow-Origin: ' . $allow);
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Max-Age: 86400');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

// ---------- Чтение JSON-тела ----------
$raw = file_get_contents('php://input');
$lead = json_decode($raw, true);
if (!is_array($lead)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Bad JSON']);
    exit;
}

$name  = isset($lead['name'])  ? trim((string)$lead['name'])  : '';
$phone = isset($lead['phone']) ? trim((string)$lead['phone']) : '';

if ($name === '' || $phone === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'name and phone required']);
    exit;
}

$name  = mb_substr($name, 0, 120);
$phone = mb_substr($phone, 0, 40);

$meta = [
    'form' => isset($lead['form']) ? (string)$lead['form'] : 'form',
    'page' => isset($lead['page']) ? (string)$lead['page'] : '',
    'ts'   => isset($lead['ts'])   ? (string)$lead['ts']   : date('c'),
    'utm'  => isset($lead['utm']) && is_array($lead['utm']) ? $lead['utm'] : [],
    'ua'   => isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '',
    'ip'   => $_SERVER['REMOTE_ADDR'] ?? '',
];

// ---------- Telegram ----------
$tg = send_to_telegram($CONFIG, $name, $phone, $meta);

// ---------- amoCRM (если включён) ----------
$amo = ['ok' => false, 'error' => 'amocrm webhook not configured'];
if (!empty($CONFIG['amocrm_webhook_url'])) {
    $amo = send_to_amocrm($CONFIG, $name, $phone, $meta);
}

echo json_encode([
    'ok'       => true,
    'telegram' => $tg,
    'amocrm'   => $amo,
]);
exit;

// =========================================================
// helpers
// =========================================================
function send_to_telegram($CONFIG, $name, $phone, $meta) {
    $token = $CONFIG['telegram_bot_token'];
    $chat  = $CONFIG['telegram_chat_id'];
    if (!$token || $token === 'PUT_YOUR_BOT_TOKEN_HERE' || !$chat || $chat === 'PUT_YOUR_CHAT_ID_HERE') {
        return ['ok' => false, 'error' => 'telegram config missing'];
    }

    $lines = [
        '<b>🎓 Заявка на мастер-класс</b>',
        '<b>Имя:</b> '     . esc($name),
        '<b>Телефон:</b> ' . esc($phone),
        '<b>Форма:</b> '   . esc($meta['form']),
    ];
    if ($meta['page'])         $lines[] = '<b>Страница:</b> ' . esc($meta['page']);
    if (!empty($meta['utm']))  $lines[] = '<b>UTM:</b> ' . esc(json_encode($meta['utm'], JSON_UNESCAPED_UNICODE));
    $lines[] = '<i>' . esc($meta['ts']) . '</i>';

    $text = implode("\n", $lines);
    $url  = 'https://api.telegram.org/bot' . $token . '/sendMessage';
    $data = [
        'chat_id'                  => $chat,
        'text'                     => $text,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
    ];

    [$status, $body] = http_post_json($url, $data);
    return [
        'ok'     => ($status >= 200 && $status < 300),
        'status' => $status,
        'body'   => substr($body, 0, 500),
    ];
}

function send_to_amocrm($CONFIG, $name, $phone, $meta) {
    $url = $CONFIG['amocrm_webhook_url'];

    // amoCRM «Входящие вебхуки» принимают form-urlencoded
    $params = [
        'contact[name]'  => $name,
        'contact[phone]' => $phone,
        'lead[name]'     => 'Заявка: ' . $meta['form'],
        'lead[tags]'     => 'ai-creator,landing',
        'lead[note]'     => "Источник: {$meta['page']}\nUTM: " . json_encode($meta['utm'], JSON_UNESCAPED_UNICODE) . "\nUA: {$meta['ua']}\nIP: {$meta['ip']}",
    ];
    $body = http_build_query($params);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
    ]);
    $resp = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [
        'ok'     => ($status >= 200 && $status < 300),
        'status' => $status,
        'body'   => substr((string)$resp, 0, 500),
    ];
}

function http_post_json($url, $data) {
    $payload = json_encode($data, JSON_UNESCAPED_UNICODE);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json; charset=utf-8'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
    ]);
    $resp   = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, (string)$resp];
}

function esc($s) {
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}
