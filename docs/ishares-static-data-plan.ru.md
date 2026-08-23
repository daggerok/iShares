# План: статические данные iShares по отдельным JSON-файлам

## Цель

Добавить воспроизводимый GitHub Actions pipeline, который получает актуальные данные активных iShares US ETF, нормализует их и публикует статический API без пустых коммитов. Данные одного фонда должны жить в отдельном JSON-файле: изменение DIVB не должно переписывать IVV, IWM и весь каталог.

Это **план**, а не реализация pipeline. Реализация начнётся в следующей агентной итерации.

## Целевая структура

```text
api/ishares/
  index.json
  funds/
    DIVB/
      meta.json
      holdings/001.json
      history/001.json
    IVV/
      meta.json
      holdings/001.json
      history/001.json
    IWM/
      meta.json
```

### `index.json`

Небольшой манифест для первого экрана и навигации:

```json
{
  "generatedAt": "2026-08-23T00:00:00.000Z",
  "source": { "market": "us", "provider": "iShares" },
  "funds": [
    {
      "ticker": "DIVB",
      "portfolioId": "291387",
      "name": "iShares Core Dividend ETF",
      "fundPage": "https://www.ishares.com/us/products/291387/...",
      "dataFile": "./funds/DIVB/meta.json",
      "asOfDate": "2026-08-22"
    }
  ]
}
```

`generatedAt` обновляется только если изменился манифест или хотя бы один нормализованный файл фонда.

### `funds/{ticker}/meta.json`

Один нормализованный документ содержит metadata, non-paginated worksheets и manifests
для больших таблиц одного ETF:

```json
{
  "ticker": "DIVB",
  "portfolioId": "291387",
  "source": { "fundPage": "...", "download": "..." },
  "holdings": {
    "totalRows": 1234,
    "pageSize": 250,
    "pageCount": 5,
    "pages": ["./holdings/001.json", "./holdings/002.json"]
  },
  "history": {
    "totalRows": 3200,
    "pageSize": 1000,
    "pageCount": 4,
    "pages": ["./history/001.json", "./history/002.json"]
  },
  "worksheets": {
    "Performance": { "headers": [], "rows": [] },
    "Distributions": { "headers": [], "rows": [] }
  }
}
```

`Holdings` и `Historical` не дублируются в `meta.json`: они хранятся в
детерминированных numeric JSON pages. На повторном запуске updater сравнивает
содержимое, обновляет только изменившиеся страницы и удаляет устаревшие страницы
после успешной загрузки. Нужно сохранять только полезные таблицы и их данные, а не
raw SpreadsheetML/XML.

## Источники и стратегия discovery

### Основной источник — вариант B

Основной job получает каталог активных US ETF из product catalog/screener, которым пользуется iShares. Для каждого элемента каталог должен дать минимум `ticker`, `name`, `portfolioId`, URL фонда и признак активности. Это лучший вариант, потому что автоматически подхватывает новые ETF и исключает закрытые.

### Fallback

Последний успешно опубликованный `api/ishares/index.json` является fallback-каталогом. Если discovery endpoint временно недоступен или возвращает подозрительно малый список, job:

1. не удаляет существующие фондовые файлы;
2. использует фондовый список из предыдущего манифеста;
3. завершает обновление с предупреждением в GitHub Actions Summary;
4. не создаёт пустой или разрушительный commit.

### Не использовать PDF как runtime-источник

Официальный Product List PDF полезен для ручной сверки, но не должен быть parser-зависимым источником регулярного pipeline: он плохо подходит для получения стабильного `portfolioId`.

## Загрузка данных фонда

Для каждого фонда job формирует официальный fund-download URL, загружает SpreadsheetML/XLS и проверяет:

- HTTP status;
- content type / минимальный размер;
- наличие хотя бы одного ожидаемого worksheet;
- наличие корректного тикера, если он есть в таблице holdings.

CSV holdings можно использовать как ускоренный fallback для holdings, но XLS остаётся предпочтительным исходником для текущего приложения: в нём есть несколько вкладок, которые UI уже умеет показывать.

## Нормализация

Перед сравнением и записью pipeline должен:

1. удалить пустые служебные строки;
2. выбрать фактическую header row (Ticker либо первая многоколонночная строка);
3. стандартизировать названия worksheet;
4. сериализовать объекты в стабильном порядке ключей;
5. сохранять строки в source order, если порядок является смысловым;
6. исключить volatile-поля (`fetchedAt`, временные request-id, generated timestamp) из сравнения.

У каждого файла может быть `asOfDate`, только если он присутствует в первичных данных и действительно изменился.

## Content-aware write

Для каждого `funds/{ticker}/meta.json` и каждой страницы `holdings/` или `history/`:

1. прочитать текущий файл, если он существует;
2. сравнить нормализованный JSON без volatile-полей;
3. писать файл только при реальном отличии;
4. использовать стабильные numeric page names вместо timestamp-имен;
5. удалить stale pages только после полной успешной обработки фонда;
6. собрать список изменившихся тикеров.

После этого строится `index.json`. Он меняется только при изменении universe, metadata, `asOfDate` либо списка реально обновлённых фондов. Таким образом один изменившийся ETF создаёт минимальный git diff.

При положительном `MAX_FETCHES` updater работает батчами: фиксированный порядок каталога продолжается после `lastProcessedTicker` в `api/ishares/update-state.json` и циклически возвращается к началу. Этот небольшой state-файл нужно коммитить вместе с data changes; удаление файла начинает последовательность заново. При `MAX_FETCHES=0` обновляется весь eligible catalog, а cursor не двигается.

## Удаление фондов

Удаление допустимо только когда основной discovery endpoint успешно получен и явно подтверждает, что фонд больше не активен. Перед удалением нужен защитный порог: если новый catalog меньше, например, 70% предыдущего, job должен считаться ошибочным и ничего не удалять.

## GitHub Actions workflow

### Запуск

- `workflow_dispatch` — обязательно;
- scheduled запуск только в рабочие дни США, после ожидаемого обновления holdings;
- concurrency group, чтобы два job не создавали конкурирующие коммиты.

### Последовательность

1. checkout c полной историей для push;
2. setup Bun с закреплённой версией;
3. `bun scripts/update-ishares-data.ts`;
4. `git add api/ishares`;
5. `git diff --cached --quiet && exit 0`;
6. commit и push только при staged изменениях.

Commit должен содержать только `api/ishares/**`; код, workflow и документация никогда не должны автоматически попасть в data commit.

## Надёжность и rate limiting

- concurrency: начать с 3–4 одновременных запросов;
- retry с exponential backoff для 429/5xx;
- timeout на каждый fund download;
- ошибка одного ETF не должна стирать его последний успешный JSON и не должна отменять остальные ETF;
- job summary должен содержать `updated`, `unchanged`, `failed`, `removed` и URL/log причины ошибок.

## Изменения UI в следующей итерации

1. Сначала загрузить `api/ishares/index.json`.
2. Показать каталог фондов и поиск без загрузки всех holdings.
3. При выборе ETF загружать `funds/{ticker}/meta.json` и первые страницы `holdings/`/`history/`; следующие страницы автоматически добавлять при прокрутке таблицы, без отображения номеров страниц.
4. Кешировать загруженный JSON в памяти; при необходимости — в IndexedDB с ключом, зависящим от `asOfDate`.
5. Сохранить текущую возможность загрузить локальный XLS как отдельный режим, а не сломать её.

## Тесты и критерии готовности

- parser fixture: DIVB XLS с Holdings/Performance/Distributions;
- fixture без колонки Ticker;
- fixture с пустой worksheet;
- unchanged run не изменяет ни одного файла и не создаёт commit;
- изменение одного фонда меняет только один fund JSON и, при необходимости, index;
- discovery failure не удаляет данные;
- UI может открыть fund JSON по относительному URL на GitHub Pages;
- итоговый размер и число запросов документированы в workflow summary.

## Этапы реализации

1. Зафиксировать discovery endpoint и построить небольшой проверяемый каталог.
2. Реализовать parser/normalizer на fixtures.
3. Добавить content-aware writer и manifest builder.
4. Добавить workflow с ручным запуском; только затем включить schedule.
5. Опубликовать initial dataset отдельным reviewable PR.
6. Перевести UI на manifest + lazy fund files, сохранив local XLS upload.
7. Наблюдать 1–2 недели, затем оптимизировать concurrency/schedule.

---

# Дополнение: опциональное сохранение исходных файлов загрузки

## Назначение

Помимо нормализованных JSON pipeline должен **опционально** сохранять исходный официальный файл iShares, из которого был построен JSON. Эти файлы не используются приложением и не загружаются браузером; они нужны для аудита, повторной диагностики parser-а и ручной проверки источника.

По умолчанию эта функция отключена. Отключённый режим не меняет список файлов, размер репозитория или обычный workflow.

## Единственная конфигурационная переменная

Использовать имя:

```text
ISHARES_STORE_RAW_DOWNLOADS
```

### Значение по умолчанию

Пустая строка:

```text
ISHARES_STORE_RAW_DOWNLOADS=""
```

означает **выключено**.

### Truthy-правило

В скрипте значение необходимо обработать так:

```ts
const STORE_RAW_DOWNLOADS = ['1', 'true', 'yes', 'y', 'on']
  .includes((process.env.ISHARES_STORE_RAW_DOWNLOADS || '').trim().toLowerCase());
```

Таким образом включают режим все варианты регистра:

```text
true, True, TRUE
yes, Yes, YES
y, Y
on, On, ON
1
```

Пустая строка, `false`, `no`, `off`, `0`, неизвестное значение или отсутствие переменной означают **выключено**. Никакого неявного truthy поведения (`"false"` как true) быть не должно.

## Как пользователь включает режим в GitHub Actions

Будущий workflow обязан иметь ручной input с пустым default:

```yaml
on:
  workflow_dispatch:
    inputs:
      store_raw_downloads:
        description: "Store downloaded iShares source files under api/ishares/raw (true/yes/on/1 to enable)"
        required: false
        default: ""
        type: string
```

И передавать его в job только через environment:

```yaml
env:
  ISHARES_STORE_RAW_DOWNLOADS: ${{ inputs.store_raw_downloads || '' }}
```

Поэтому при обычном scheduled run и обычном ручном запуске переменная пуста, а raw-файлы не пишутся. Для специального аудиторского запуска пользователь вводит, например, `true` или `yes` в поле **store_raw_downloads**.

Если workflow позже получит `workflow_call`, этот input также должен иметь default `""`; secret для этой функции не нужен.

## Расположение и формат raw-файлов

Сохранять только **последнюю успешно скачанную версию на ETF**, а не бесконечную историю дат:

```text
api/ishares/raw/{TICKER}.xls
```

Примеры:

```text
api/ishares/raw/DIVB.xls
api/ishares/raw/IVV.xls
api/ishares/raw/IWM.xls
```

Причины выбора:

1. Нужен именно исходник, по которому построен текущий JSON.
2. Git уже хранит историю изменений файлов; отдельные timestamp-копии многократно раздуют repository.
3. Один текущий raw-файл на фонд делает путь предсказуемым для человека и diagnostic tooling.
4. Расширение `.xls` соответствует официальному Data Download, хотя фактическое содержимое может быть SpreadsheetML/XML; parser должен определять формат по содержимому, а не по расширению.

Raw-файлы остаются внутри `api/`, как требуется, но UI никогда не должен автоматически их fetch-ить.

## Алгоритм обработки raw-файла

Для каждого фонда pipeline сначала скачивает исходный response в память/временный файл, затем:

1. проверяет HTTP status, content-type, минимальный размер и parser fixture;
2. нормализует его в `funds/{TICKER}/meta.json` и детерминированные страницы в `holdings/` и `history/`;
3. если `STORE_RAW_DOWNLOADS === true`, сравнивает байты ответа с `api/ishares/raw/{TICKER}.xls`;
4. записывает raw-файл только если байты действительно отличаются;
5. если режим выключен, **не трогает уже существующие raw-файлы** — не перезаписывает и не удаляет их;
6. если загрузка фонда неуспешна, не меняет ни JSON, ни raw-файл этого фонда.

Важно: raw byte diff и normalized JSON diff независимы. Возможны оба случая:

- raw изменился, а JSON после нормализации не изменился — при включённом флаге commit содержит только raw-файл;
- raw не изменился, а JSON изменился из-за улучшения normalizer-а — commit содержит JSON;
- оба не изменились — commit отсутствует.

## Git staging и commit

Обычный режим должен stage-ить только нормализованный API:

```bash
git add api/ishares/index.json api/ishares/funds
```

Режим raw-downloads должен дополнительно stage-ить raw directory:

```bash
git add api/ishares/index.json api/ishares/funds api/ishares/raw
```

В обоих случаях commit выполняется только при staged diff:

```bash
git diff --cached --quiet && exit 0
git commit -m "Update iShares ETF data"
git push
```

Commit message можно дополнить количеством обновлённых JSON/raw файлов в body, но не нужно делать новый commit только ради Summary или timestamp.

## Safety limits для raw режима

До включения scheduled raw mode реализация должна иметь следующие защиты:

- лимит максимального размера одного файла с понятной ошибкой;
- лимит суммарного объёма raw изменений за один job;
- concurrency 3–4, retry/backoff для 429 и 5xx;
- workflow summary: `raw mode enabled`, downloaded, unchanged, raw written, failures, bytes;
- raw-файлы не удаляются автоматически вместе с исчезнувшим ETF без отдельного успешного reviewable процесса;
- при подозрительно неполном catalog job не должен удалять ни JSON, ни raw-файлы.

## Изменённая последовательность следующей реализации

1. Добавить `workflow_dispatch.inputs.store_raw_downloads` с default `""` и environment mapping.
2. Добавить строгий parser truthy-значений и unit tests для пустой строки, `false`, `true`, `YES`, `on`, `1`, неизвестного текста.
3. Реализовать discovery + fallback catalog.
4. Реализовать download, validation и normalizer на fixtures.
5. Реализовать `index.json` + отдельные `funds/{ticker}/meta.json` и постраничные `holdings/`/`history/` с content-aware write.
6. Реализовать raw writer в `api/ishares/raw/{ticker}.xls`, вызываемый только в enabled-режиме.
7. Добавить staged-diff workflow и GitHub Actions Summary.
8. Выполнить первый ручной запуск **без** raw mode и закоммитить initial JSON dataset.
9. Выполнить отдельный ручной запуск с `store_raw_downloads=true`; проверить размер/дифф raw dataset до решения о регулярном использовании.
10. Только после review включать расписание и при необходимости scheduled raw mode.

## Критерии приёмки raw режима

- без input / при пустом input raw-файлы не создаются и не изменяются;
- `true`, `TRUE`, `Yes`, `y`, `on`, `1` включают запись raw;
- `false`, `no`, `off`, `0` и неизвестный текст не включают запись;
- повторный enabled run с теми же байтами не создаёт commit;
- raw-файл и JSON не записываются при ошибочной загрузке;
- UI продолжает работать только с JSON и не зависит от наличия raw directory;
- PR первого dataset содержит все generated JSON, а enabled raw PR также содержит все фактически скачанные raw `.xls` файлы.
