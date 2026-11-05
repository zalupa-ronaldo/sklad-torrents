"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { DISC_IMAGE_STUDIO_RELEASES, DISC_IMAGE_STUDIO_REPO } from "@/lib/optical/disc-image-studio";

interface CatalogImage {
  hostId: string;
  hostName: string;
  hostOs: string;
  torrent: string;
  path: string;
  name: string;
}

interface Capabilities {
  hostPlatform: string;
  license: string;
  liveBurn: { experimental: boolean; cliCommand: string; note: string };
}

type Platform = "darwin" | "linux" | "win32";
type Medium = "cd" | "dvd" | "bd-r";

export function OpticalPanel() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [images, setImages] = useState<CatalogImage[]>([]);
  const [platform, setPlatform] = useState<Platform>("linux");
  const [medium, setMedium] = useState<Medium>("cd");
  const [artworkPath, setArtworkPath] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [filePosition, setFilePosition] = useState<"inner" | "outer">("inner");
  const [outputPath, setOutputPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api<Capabilities>("/api/optical/capabilities")
      .then((next) => {
        setCapabilities(next);
        if (next.hostPlatform === "darwin" || next.hostPlatform === "win32" || next.hostPlatform === "linux") {
          setPlatform(next.hostPlatform);
        }
      })
      .catch(() => setCapabilities(null));
    void api<{ images: CatalogImage[] }>("/api/optical/catalog")
      .then((next) => setImages(next.images))
      .catch(() => setImages([]));
  }, []);

  async function submit(action: "export" | "burn") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await api<{ id: string; state: string; title: string }>("/api/optical/disc-image", {
        method: "POST",
        body: JSON.stringify({
          platform,
          action,
          medium,
          artworkPath,
          dataDir,
          filePosition,
          outputPath,
        }),
      });
      setNotice(`Задача «${job.title}» в очереди (${job.state}). Диск в этом окружении не записывается.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось поставить задачу");
    } finally {
      setBusy(false);
    }
  }

  const windows = platform === "win32";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Рисунок на поверхности диска</h1>
        <Link href="/progress" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Прогресс
        </Link>
      </header>

      <section className="grid gap-3 rounded-xl border bg-card p-4 text-sm leading-6">
        <p>
          DiscImageStudio наносит видимый глазом узор на CD, DVD и однослойный BD-R. Код проекта под лицензией{" "}
          {capabilities?.license ?? "GPL-3.0-or-later"} сюда не входит: Склад только вызывает отдельно установленный
          официальный бинарник.
        </p>
        <p>
          <a className="underline underline-offset-4" href={DISC_IMAGE_STUDIO_REPO}>
            Репозиторий
          </a>
          {" · "}
          <a className="underline underline-offset-4" href={DISC_IMAGE_STUDIO_RELEASES}>
            релизы
          </a>
          . Если программы нет, задача завершится ошибкой «DiscImageStudio не найден».
        </p>
        <p>
          На macOS и Linux действие одно: <strong>собрать офлайн-образ</strong>. Экспериментальный CLI не пишет диск.
          Живая запись через IMAPI2 есть только у Windows-приложения и помечена как экспериментальная. Кнопка «Записать»
          ставит в очередь команду <span className="font-mono">burn-devices</span>: она показывает приводы IMAPI2 и не
          прожигает болванку.
        </p>
        <p className="text-muted-foreground">
          Двухслойный BD и DVD-DL эта форма не примет. VLESS не используется. В этом облаке диск не записывался и
          видимый рисунок на носителе не проверялся.
        </p>
      </section>

      <form
        className="grid gap-4 rounded-xl border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit("export");
        }}
      >
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Куда относится задача</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["darwin", "macOS"],
                ["linux", "Linux"],
                ["win32", "Windows"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPlatform(id)}
                className={chip(platform === id)}
                aria-pressed={platform === id}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {windows
              ? "На Windows можно собрать офлайн-образ или поставить в очередь экспериментальный опрос IMAPI2. Аппаратный путь экспериментальный."
              : "На macOS и Linux доступна только сборка офлайн-образа. Кнопки живой записи нет."}
          </p>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Носитель</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["cd", "CD"],
                ["dvd", "DVD"],
                ["bd-r", "BD-R, один слой"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMedium(id)}
                className={chip(medium === id)}
                aria-pressed={medium === id}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="grid gap-1.5 text-sm">
          Рисунок из каталога
          <select
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
            value={images.some((image) => image.path === artworkPath) ? artworkPath : ""}
            onChange={(event) => {
              const image = images.find((item) => item.path === event.target.value);
              if (!image) return;
              setArtworkPath(image.path);
              if (image.hostOs === "win32" || image.hostOs === "darwin") setPlatform(image.hostOs);
            }}
            aria-label="Рисунок из каталога"
          >
            <option value="">Выберите JPG, PNG, GIF или BMP</option>
            {images.map((image) => (
              <option key={`${image.hostId}:${image.path}`} value={image.path}>
                {image.hostName}: {image.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1.5 text-sm">
          Или путь к картинке
          <Input
            value={artworkPath}
            onChange={(event) => setArtworkPath(event.target.value)}
            placeholder="/Volumes/vault/cover.png или D:\Pictures\cover.png"
            aria-label="Путь к рисунку"
          />
        </label>

        <label className="grid gap-1.5 text-sm">
          Папка с файлами на диске, необязательно
          <Input
            value={dataDir}
            onChange={(event) => setDataDir(event.target.value)}
            placeholder="Пустая — только рисунок"
            aria-label="Папка с файлами"
          />
        </label>

        <fieldset className="grid gap-2" disabled={!dataDir.trim()}>
          <legend className="text-sm font-medium">Где лежат файлы</legend>
          <div className="flex gap-2">
            <button type="button" className={chip(filePosition === "inner")} onClick={() => setFilePosition("inner")}>
              Внутреннее кольцо
            </button>
            <button type="button" className={chip(filePosition === "outer")} onClick={() => setFilePosition("outer")}>
              Внешнее кольцо
            </button>
          </div>
        </fieldset>

        <label className="grid gap-1.5 text-sm">
          Куда положить образ, необязательно
          <Input
            value={outputPath}
            onChange={(event) => setOutputPath(event.target.value)}
            placeholder="Если пусто, Склад выберет файл в data/optical-output"
            aria-label="Путь готового образа"
          />
        </label>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error.includes("http") ? <ErrorWithLink text={error} /> : error}
          </p>
        ) : null}
        {notice ? (
          <p className="text-sm" role="status">
            {notice}{" "}
            <Link href="/progress" className="underline underline-offset-4">
              Открыть прогресс
            </Link>
          </p>
        ) : null}
        {busy ? <p className="text-xs text-muted-foreground">Ставим в очередь, интерфейс не ждёт прожиг.</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            Собрать офлайн-образ
          </Button>
          {windows ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void submit("burn")}>
              Записать
            </Button>
          ) : null}
        </div>
        {windows ? (
          <p className="text-xs text-warn">
            «Записать» не запускает лазер. В очередь попадает экспериментальный опрос IMAPI2 (`burn-devices`). Живая
            запись остаётся в окне DiscImageStudio на Windows и в документации названа экспериментальной.
          </p>
        ) : null}
      </form>
    </div>
  );
}

function chip(active: boolean): string {
  return active
    ? "rounded-full bg-primary px-3 py-1 text-xs text-primary-foreground"
    : "rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground";
}

function ErrorWithLink({ text }: { text: string }) {
  const match = text.match(/https?:\/\/\S+/);
  if (!match || match.index === undefined) return text;
  const url = match[0];
  return (
    <>
      {text.slice(0, match.index)}
      <a className="underline underline-offset-4" href={url}>
        {url}
      </a>
      {text.slice(match.index + url.length)}
    </>
  );
}
