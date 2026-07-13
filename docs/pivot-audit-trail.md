# Pivot: från loggservice till clomp

**Status:** beslutad · **Datum:** 2026-07-13

## Vision

Projektet byter namn till **clomp** och fokus: från generell logginsamling (en marknad som
ägs av Loki/SigNoz/Datadog) till **manipulationssäker händelse- och bevisföring för
säkerhetsarbete**.

Produktidén i en mening:

> En självhostad, append-only händelselogg med kryptografisk kedja som gör att en verksamhet
> kan *bevisa* — inte bara påstå — att säkerhetsarbetet utförs.

Karaktären är medvetet "tråkig och cool på samma gång": inga dashboards med realtidsgrafer,
ingen AI-magi — bara en logg som inte går att ändra i efterhand, och en rapport som håller
i en revision. Tråkigheten *är* värdet.

## Varför nu

- **NIS2 / nya cybersäkerhetslagen** träffar tusentals europeiska verksamheter (kommuner, vård,
  energi, deras leverantörer) med krav på *dokumenterat* systematiskt säkerhetsarbete.
- **SOC 2** driver samma behov hos varje B2B-SaaS som säljer till enterprise: bevis på att
  kontroller utförs löpande, inte bara att de finns på papper.
- Dagens verklighet är Excel-ark och Word-dokument inför revisionen.
- Incumbents (Vanta, Drata) är dyra, stängda SaaS — och ofta omöjliga för offentlig sektor
  som kräver EU-hosting/self-hosted. Det finns inget bra open source-alternativ i nischen.
- Grunden är **redan self-hosted**. Det som var en svaghet mot Datadog är ett säljargument
  mot en kommun — och som open source blir det dessutom gratis att införa.

## Måltavla

**SOC 2 och NIS2** är de två ramverk clomp uttryckligen stödjer: action-katalogen seedas
mot båda, och exporterna (utdrag + snygga PDF:er) formuleras så att de går att lämna
direkt till en revisor i respektive process.

## Två spår, en kärna

| | Spår 1: Audit trail-API | Spår 2: Säkerhetsloggboken |
|---|---|---|
| Kund | Utvecklingsteam i B2B-appar | Säkerhetsansvarig / CISO |
| Användning | Appen loggar typade händelser via API/SDK | Människor loggar säkerhetsaktiviteter via UI |
| Exempel | "user X ändrade behörighet Y" | "åtkomstgranskning Q3 genomförd, underlag bifogat" |
| Köpdrivare | Kundkrav på audit trail | Revision / NIS2-tillsyn |

Båda spåren är samma tekniska kärna: append-only händelser med aktör/åtgärd/objekt,
hash-kedja, retention, export. Spår 1 är API:et, spår 2 är produkten ovanpå.
MVP bygger kärnan + det minsta av spår 2 som håller i en revision.

## Datamodell

`logs`-tabellen ersätts av en typad `events`-tabell (Postgres):

```sql
CREATE TABLE events (
  id             UUID PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  sequence       BIGINT NOT NULL,           -- per tenant, monoton, luckfri
  occurred_at    TIMESTAMPTZ NOT NULL,      -- när händelsen inträffade
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- när den loggades
  actor          JSONB NOT NULL,            -- { type: user|service|system, id, name, ip? }
  action         TEXT NOT NULL,             -- namespaced: "access.review.completed"
  target         JSONB,                     -- { type, id, name } — det som påverkades
  context        JSONB,                     -- fritt metadata
  evidence       JSONB,                     -- [{ filename, sha256, size, storage_ref }]
  prev_hash      BYTEA NOT NULL,            -- hash för sequence-1 (genesis: 32 nollbytes)
  hash           BYTEA NOT NULL,            -- se Hash-kedja nedan
  UNIQUE (tenant_id, sequence)
);
```

Principer:

- **Append-only på databasnivå:** applikationsanvändaren i Postgres har `INSERT` + `SELECT`
  men inte `UPDATE`/`DELETE` på `events`. Retention hanteras av en separat privilegierad roll.
- **`occurred_at` ≠ `recorded_at`:** efterregistrering är tillåten och *synlig* — det är en
  feature i revisionssammanhang, inte ett hål.
- **Bilagor är del av kedjan:** filens SHA-256 ligger i händelsen, så underlaget är lika
  manipulationssäkert som händelsen själv. Filerna lagras utanför DB (disk/S3-kompatibelt).
- **Action-katalog:** namespaced strängar med en seedad katalog för NIS2- och SOC 2-aktiviteter
  (`access.review.*`, `patch.applied`, `incident.*`, `training.completed`, `risk.decision`,
  `vendor.review`, `backup.tested`, …), taggade med vilka kontroller/artiklar de svarar mot.
  Katalogen är utbyggbar per tenant; okända actions tillåts men flaggas i rapporten.

## Hash-kedja (kärnvärdet)

```
canonical = kanonisk JSON av (tenant_id, sequence, occurred_at, recorded_at,
                              actor, action, target, context, evidence)
hash      = SHA-256( prev_hash || canonical )
```

- **Per tenant**, genesis har `prev_hash = 0x00…00`.
- Kanonisk JSON = sorterade nycklar, ingen whitespace, UTF-8 — specas exakt och testas
  mot referensvektorer så SDK:er kan verifiera oberoende av servern.
- Insert av (sequence, prev_hash) sker i en transaktion med lås per tenant så kedjan
  aldrig grenar sig.

**Checkpoints:** varje natt signeras senaste `(tenant_id, sequence, hash)` med serverns
Ed25519-nyckel och sparas i en `checkpoints`-tabell. Checkpointen kan dessutom skickas
till en extern mottagare (e-post till revisorn, publicering av digest) så att inte ens
den som har root på servern kan skriva om historiken bakåt utan att det syns. Extern
ankring är valfri konfiguration, inte MVP-krav.

**Verifiering:** `GET /api/verify?from=&to=` räknar om kedjan och returnerar antingen
`{ intact: true, verified: N }` eller första brottet med sequence-nummer. CLI-kommando
för samma sak, körbart av revisorn utan API-åtkomst (läser en JSONL-export).

## Export (det revisorn faktiskt ber om)

Utdrag och snygga PDF:er är en del av kärnmålet, inte efterarbete:

- **JSONL-export** per tidsperiod: händelserna + checkpoint-signaturer, verifierbar offline.
- **PDF-rapport** per tidsperiod: sammanfattning per aktivitetstyp mappad mot SOC 2-kontroller /
  NIS2-artiklar, händelselista, bilageförteckning med hashar, verifieringsintyg
  ("kedjan intakt, N händelser, signerad checkpoint X"). Formgivningen ska vara bra nog
  att lämna vidare utan efterbearbetning — rapporten är produktens ansikte utåt.

## Auth görs om

- **UI:** riktiga användare (e-post + lösenord/passkey) med roller: `admin`, `editor`
  (får logga händelser), `auditor` (read-only + export). API-nyckel-i-localStorage tas bort.
- **API:** nycklar behålls för maskinklienter (spår 1) men lagras **hashade** i DB
  (idag jämförs de i klartext i `middleware/auth.js`) och prefixas (`lsk_live_…`) så de
  går att identifiera i läckor.

## Skalas bort

| Bort | Varför |
|---|---|
| SQLite-stödet + `DatabaseAdapter` | Dubbelstödet är största enskilda komplexiteten; Postgres krävs ändå för radnivårättigheter och `JSONB` |
| Java- och TypeScript-SDK | Tre SDK:er är underhållsbörda utan kunder; behåll Node-SDK:n + ren REST, resten senare vid behov |
| Fritext-`logs`-modellen | Ersätts av `events`; ingen migrering av gammal data behövs (inga externa användare) |
| Nattlig JSONL-arkivering som *primär* mekanism | Postgres bär hela datamängden (volymerna är små i audit-sammanhang); JSONL blir exportformat istället för lagringsnivå |

## Buggfixar som följer med

- `GET /api/logs` saknar `LIMIT` i SQL:en — hela tabellen laddas i minnet och pagineras i JS
  (`backend/src/routes/logs.js`). Nya `GET /api/events` byggs med LIMIT/OFFSET (eller
  keyset-paginering på `sequence`) från start.
- API-nycklar i klartext i DB (se Auth ovan).

## MVP-avgränsning

**I MVP:**

1. `events`-tabell + hash-kedja + checkpoints (Postgres-only)
2. `POST/GET /api/events`, `GET /api/verify`
3. Action-katalog seedad mot NIS2 och SOC 2
4. Bilagor med hash-koppling
5. Användare + roller i UI; formulär för att logga aktivitet; händelselista med filter
6. JSONL-export med offline-verifiering + PDF-rapport (rapporten är en del av kärnmålet)
7. Node-SDK uppdaterad till events-modellen

**Inte i MVP** (men på kartan):

- Påminnelser/schema ("åtkomstgranskning Q3 ej loggad")
- Extern ankring av checkpoints
- i18n (svenska m.fl.) — UI och docs skrivs på engelska först
- Integrationer (hämta händelser automatiskt från AD/Entra, patch-system, ärendesystem)
- Multitenancy i drift — MVP är self-hosted, en organisation per installation
  (`tenants` finns i schemat från start så det inte kräver migrering senare)

## Beslut (2026-07-13)

1. **Namn: clomp.** GitHub-repot döps om till `sockulags/clomp` (manuellt steg för Lucas;
   GitHub redirectar gamla URL:er automatiskt).
2. **Engelska först.** UI, README och all publik dokumentation på engelska; i18n
   (svenska m.fl.) är ett senare spår. Detta dokument förblir internt på svenska.
3. **Open source, MIT.** Helt fri — **ingen betalfunktion i tjänsten alls**. Alla features,
   inklusive påminnelser och PDF-rapporter, är gratis. Motivet är dels adoption (kommuner
   och SME kan bara ta in den), dels karriärvärde: ett välbyggt open source-projekt i en
   verklig nisch väger tyngre än en stängd produkt utan användare.
4. **Monetisering är explicit uppskjuten.** Först när projektet fått verklig traction
   (forks, stjärnor, installationer) övervägs tilläggstjänster runt tjänsten — on-prem-stöd,
   drift, support — aldrig betalväggar i koden.

5. **Auth: lösenord först, passkeys som steg två.** MVP: lösenord (argon2id) + valbar TOTP
   (kan tvingas per instans av admin), recovery-koder vid TOTP-aktivering, CLI-kommando för
   admin-återställning. Passkeys (WebAuthn) läggs på i nästa release — WebAuthn kräver HTTPS
   + stabilt domännamn och fungerar inte på intranätsinstallationer via IP, vilket är en stor
   del av målgruppens verklighet. Externa revisorer med tillfällig åtkomst ska inte tvingas
   registrera passkey.

## Ordning

1. Riv ut SQLite-adaptern och extra SDK:er (ren minskning, gör allt annat lättare)
2. `events`-schema + hash-kedja + verify-endpoint, med referensvektorer och tester
3. Auth-omgörningen (användare/roller, hashade API-nycklar)
4. UI: logga aktivitet + händelselista
5. Export + checkpoints
