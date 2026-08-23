# План: статические данные iShares по отдельным JSON-файлам

## Цель

Добавить воспроизводимый GitHub Actions pipeline, который получает актуальные данные активных iShares US ETF, нормализует их и публикует статический API без пустых коммитов. Данные одного фонда должны жить в отдельном JSON-файле: изменение DIVB не должно переписывать IVV, IWM и весь каталог.

Это **план**, а не реализация pipeline. Реализация начнётся в следующей агентной итерации.

## Целевая структура

```text
api/ishares/
  index.json
  funds/
    DIVB.json
    IVV.json
    IWM.json
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
      "dataFile": "./funds/DIVB.json",
      "asOfDate": "2026-08-22"
    }
  ]
}
```

`generatedAt` обновляется только если изменился манифест или хотя бы один нормализованный файл фонда.

### `funds/{ticker}.json`

Один нормализованный документ содержит данные одного ETF:

```json
{
  "ticker": "DIVB",
  "portfolioId": "291387",
  "source": { "fundPage": "...", "download": "..." },
  "worksheets": {
    "Holdings": { "headers": [], "rows": [] },
    "Performance": { "headers": [], "rows": [] },
    "Distributions": { "headers": [], "rows": [] }
  }
}
```

Нужно сохранять только полезные таблицы и их данные, а не raw SpreadsheetML/XML.

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

Для каждого `funds/{ticker}.json`:

1. прочитать текущий файл, если он существует;
2. сравнить стабильный JSON без `generatedAt`;
3. писать файл только при реальном отличии;
4. собрать список изменившихся тикеров.

После этого строится `index.json`. Он меняется только при изменении universe, metadata, `asOfDate` либо списка реально обновлённых фондов. Таким образом один изменившийся ETF создаёт минимальный git diff.

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
3. При выборе ETF загружать `funds/{ticker}.json`.
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
