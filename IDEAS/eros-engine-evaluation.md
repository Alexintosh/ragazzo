# Eros Engine: verifica preliminare e prova isolata

Valutazione del 29 ottobre 2026. Scopo: verificare il servizio completo prima di decidere se riusarlo o estrarne componenti. Nessuna integrazione nel runtime di Rakazo in questa fase.

## Versione e limiti della revisione

- Sorgente: [Eros Engine v2.5.2, commit `39211ecd83939be92bf40960e031ff168966a753`](https://github.com/etherfunlab/eros-engine/tree/39211ecd83939be92bf40960e031ff168966a753).
- Immagine ARM64: `ghcr.io/etherfunlab/eros-engine@sha256:8fc6240a83dbecead160b852f2cefabfd407a101078dc59856d4a1ff246fcb4d`.
- Database separato: `pgvector/pgvector@sha256:a45475a5bc7882f19e9ca17d49b67f665fa04d500350de2c47af325662445aec`.
- Revisione statica mirata di autenticazione, accessi a rete/filesystem, avvio, migrazioni e dipendenze dichiarate. Due revisioni indipendenti del sorgente e revisione critica del test. Non è un audit completo delle dipendenze o del binario.
- Il digest rende ripetibile la selezione dell'immagine; non dimostra che il binario corrisponda al sorgente esaminato. La [workflow di release](https://github.com/etherfunlab/eros-engine/blob/39211ecd83939be92bf40960e031ff168966a753/.github/workflows/release-docker.yml) disabilita la provenance.

## Risultati di sicurezza

### Token firmati senza scadenza accettati

Il [validatore JWT](https://github.com/etherfunlab/eros-engine/blob/39211ecd83939be92bf40960e031ff168966a753/crates/eros-engine-server/src/auth/supabase.rs) svuota i claim obbligatori, disabilita il controllo dell'audience e non configura quello dell'issuer. Verifica la scadenza solo se presente. Nella prova, un token firmato con la chiave sintetica ma senza `exp` ha ottenuto HTTP 200 sulla cronologia della propria sessione. Firme errate e token mancanti sono stati rifiutati.

Non consente di falsificare una firma. Resta un problema per un servizio che riutilizzi chiavi di un identity provider: prima dell'integrazione occorrono claim obbligatori, issuer e audience attesi. Nel test: chiave temporanea dedicata, utenti sintetici e token ordinari a scadenza breve.

### Rete, segreti e operazioni autonome

- I provider configurati possono effettuare richieste in uscita. BYOK include difese SSRF; l'opzione che consente reti private le riduce. BYOK/BYOC e segreti delle API di export/cancellazione sono rimasti non configurati.
- `PROMPT_LOG_DIR` salva prompt completi senza redazione: lasciato disattivato. La cattura separata dei prompt di valutazione riguarda esclusivamente contenuti sintetici.
- Disattivati dreaming, dreaming voice, snapshot, world, town, stories, chat queue e profile rebuild. Le elaborazioni per turno abilitate nel test vanno considerate separatamente dai processi periodici.
- Le migrazioni includono operazioni distruttive su colonne precedenti: eseguite esclusivamente sul database temporaneo. Il database di Rakazo non è coinvolto.
- Il Dockerfile upstream non seleziona un utente non privilegiato. La prova impone UID non root, root filesystem in sola lettura, capability rimosse, `no-new-privileges` e limiti di CPU, memoria e processi.
- La ricerca mirata non ha individuato API per l'esecuzione di comandi host. Questo non costituisce prova di assenza di vulnerabilità.

## Prova infrastrutturale eseguita

Engine su rete Docker interna, senza porte pubblicate, mount di file host o socket Docker. Database e piccoli file di configurazione in filesystem RAM temporanei. Un controllo verso un IP pubblico è fallito come atteso; questo controllo singolo non certifica l'assenza di ogni percorso verso host o LAN.

| Controllo | Esito |
|---|---|
| Migrazioni PostgreSQL con pgvector | Completate |
| Import di un personaggio sintetico | Completato |
| Avvio e health check | Versione 2.5.2 operativa |
| Creazione sessione autenticata | Riuscita |
| Token mancante o firma errata | HTTP 401 |
| Lettura cronologia da un altro utente | HTTP 403 |
| Token firmato senza scadenza | HTTP 200: difetto confermato |
| Riavvio dell'engine con database ancora attivo | Stessa sessione ripresa |
| Rimozione container e rete del test | Verificata |

La persistenza verificata riguarda il riavvio dell'engine, non il riavvio del database RAM né il riavvio della macchina. Nessuna conversazione reale di Rakazo è stata importata.

## Prova conversazionale

Configurazione eseguita: stesso personaggio, stessi due messaggi italiani, utenti/sessioni sintetici distinti, stato relazionale basso e alto. Quattro risposte valide, `affinity_scope=full`, temperature 0.7; recupero vettoriale disabilitato perché il provider di prova restituisce HTTP 404 per gli embeddings. Nessun embedding simulato. Anche con `memory_scope=none` il post-processing ha tentato scritture vettoriali, fallite sul provider: il parametro non disattiva quelle scritture.

L'engine resta nella rete interna. Un gateway di test scritto per la prova inoltra soltanto chat ed embeddings a una destinazione fissa, senza redirect, proxy automatici o credenziali del prodotto. Il bearer sintetico del gateway non viene trasmesso al provider. Budget massimo di chiamate e dimensioni limitate.

Questa configurazione può valutare la generazione e l'affinità per turno. Non dimostra qualità della memoria a lungo termine, estrazione, iniziativa spontanea o progressione su molte conversazioni. Latenze osservate includono il gateway di test e non costituiscono benchmark di produzione.

Gli eventi di completamento qualificati includevano un generation ID reale, nessuna troncatura e una risposta salvata. Tutti e quattro i turni hanno prodotto un evento di affinità e una clausola emotiva persistita. È quindi verificata anche la catena di aggiornamento per turno, non soltanto la risposta della chat.

La lettura esplorativa dei quattro campioni mostra un contrasto netto: nelle due condizioni basse il personaggio rifiuta il contatto in modo ostile, nelle due alte risponde affettuosamente o accetta la compagnia. È un controllo grossolano del comportamento, non una valutazione calibrata della naturalezza o una prova statistica. Sono stati modificati insieme quattro assi e due livelli: il risultato non identifica il contributo di ciascuno. Il prompt upstream può tradurre valori bassi in inimicizia, mentre noi potremmo volere soltanto una conoscenza iniziale. Una risposta alta promette inoltre di inviare la posizione: non dimostra una capacità realmente disponibile.

Una prima esecuzione non qualificata aveva prodotto fallback dopo timeout. Il gateway di prova serializzava generazione ed elaborazioni successive; è stato corretto per gestirle in parallelo. Il provider è stato verificato e configurato senza ragionamento lungo. Quei fallback sono esclusi dai quattro campioni sopra. Questo evidenzia anche l'importanza di rendere visibili errori e fallback nelle valutazioni.

## Pannello locale per prove manuali

Il [README della release](https://github.com/etherfunlab/eros-engine/blob/39211ecd83939be92bf40960e031ff168966a753/README.md) dichiara che il client Eros Chat è closed source. Il server OSS espone documentazione API e lettura dell'affinità, non una chat amministrativa con modifica dei valori.

Per la prova manuale è stato preparato un pannello temporaneo separato, con chat, modifica diretta di trust/intrigue/intimacy/tension, livelli warmth/patience, preset e nuova conversazione. La lettura dei valori derivati passa dall'API Eros, evitando formule duplicate. Il salvataggio manuale azzera la clausola emotiva precedente e i delta in attesa. Una nuova conversazione usa un'identità sintetica nuova per evitare memorie globali della prova precedente.

Controller limitato al loopback, con validazione di Host, Origin, token anti-CSRF e valori numerici. Nessuna modifica al prodotto Rakazo. Lo stato è temporaneo: sopravvive alla ricarica della pagina e al riavvio dell'engine con DB attivo, ma viene eliminato arrestando l'ambiente di prova RAM. Le nuove immagini hanno una dimensione nominale complessiva di circa 611 MB; nessuna compilazione Rust o nuova installazione di dipendenze host.

## Esperimento di lingua dei prompt e tempo

Il pannello sperimentale supporta `English` e `Original Chinese`. La variante inglese modifica le istruzioni effettivamente inviate al modello per chat, valutazione dell'affinità e sintesi emotiva. Non traduce il testo del riquadro dopo la generazione. Eros salva normalmente i nuovi motivi e le nuove clausole in inglese; conversazioni e memorie precedenti conservano la lingua originale.

La sostituzione avviene nel gateway della prova, tramite un catalogo legato alla versione esaminata, senza ricompilare Rust. Non è una localizzazione completa del servizio: i sottosistemi disabilitati restano fuori dal catalogo. Strutture ambigue, citazioni e rami opzionali non coperti vengono lasciati invariati e segnalati come copertura parziale. Questo limite va mantenuto visibile quando si interpretano i risultati.

Nove test deterministici verificano identità della variante cinese, contratti JSON, limiti dei punteggi, traduzioni dei rami attivi e conservazione dei dati citati. Una prova reale su un'identità sintetica separata ha verificato tutti e tre i task inglesi e una clausola inglese persistita dall'engine. La sessione del pannello è stata conservata durante l'aggiornamento del gateway. Non è ancora una valutazione comparativa della qualità inglese/cinese.

I controlli temporali distinguono il fuso orario nativo del personaggio dall'invecchiamento artificiale del timestamp dell'affinità. Il secondo usa il decadimento nativo, ma non sposta cronologia, eventi o timer. Il percorso standard della chat vieta la narrazione delle azioni: le mosse follow/listen/ask/judge non sono modalità narrative. Una modalità narrativa richiederebbe modifiche esplicite alle istruzioni di output e ai limiti di lunghezza.

## Vincoli per un'eventuale integrazione

1. **Un solo proprietario dello stato.** Il servizio completo Eros possiede memoria, prompt, stato e salvataggi. Inserirlo come semplice trasporto LLM nel `RoleplayRuntime` attuale duplicherebbe queste responsabilità. Servirebbe un confine di orchestrazione prima della costruzione del contesto di Rakazo.
2. **Stop e commit del turno.** L'interruzione HTTP non equivale all'annullamento del lavoro Eros. Occorre verificare stop, replay, idempotenza e post-processing rispetto alla finalizzazione atomica di Rakazo.
3. **Isolamento delle identità.** Parte della memoria Eros è globale per utente e condivisa fra personaggi. `memory_scope` limita l'iniezione, non tutte le scritture. Team, utente, bot e conversazione vanno mappati esplicitamente; reset e cancellazione devono coprire entrambi i sistemi.
4. **Provider e licenza.** La chat supporta endpoint compatibili; gli embeddings richiedono vettori di 512 dimensioni. Eros dichiara AGPL-3.0-only, Rakazo Apache-2.0: valutare gli obblighi rispetto alla concreta modalità di riuso prima dell'adozione.
5. **Misure diverse.** I sei assi Eros non equivalgono ai tre score Rakazo. In questa versione trust/intrigue/intimacy/tension alimentano due progressioni; warmth/patience derivano anche da livelli valutati nel turno. Non rinominare semplicemente i campi.

## RisuAI e SillyTavern restano riferimenti distinti

Indipendentemente dal risultato Eros, conservare come obiettivi: ispezione del prompt realmente inviato, budget e precedenze esplicite, tracciamento delle attivazioni del lorebook, memoria con provenienza e rollback, variabili di progressione e adattamento ai formati dei provider. Sono capacità del contesto e del prodotto che un motore relazionale non sostituisce.

Riferimenti: [RisuAI](https://github.com/kwaroran/Risuai), [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/), [ricerca iniziale](./roleplay-relationship-engine-research.md).
