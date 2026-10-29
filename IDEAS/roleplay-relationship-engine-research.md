# Motore relazionale RP: ricerca e ipotesi da verificare

Ricognizione del 29 ottobre 2026. Documento di ricerca, non specifica approvata né implementazione. Tre ricerche parallele su repository, paper e controllo del comportamento; fonti primarie consultate sul web, senza installare o eseguire progetti esterni. I link ai branch sono riferimenti mobili: questa nota descrive quanto consultato alla data indicata.

## Conclusione provvisoria

Una matrice di valori è una buona rappresentazione dello stato, ma non basta come interfaccia verso il modello. Il pattern da sperimentare è **stato persistente → scelta comportamentale → istruzioni del turno → realizzazione linguistica**. Rendere deterministiche le regole di aggiornamento e la selezione delle azioni non rende automaticamente deterministico il significato della risposta generata.

Non abbiamo trovato una scala scientificamente validata che trasformi un livello universale di amore o intimità in comportamento affidabile su qualunque LLM. Esistono implementazioni utili e risultati empirici su componenti separati. Occorre calibrare il prodotto sui modelli, sulle lingue e sugli scenari effettivamente supportati.

## Situazione di Rakazo

Il motore conserva una memoria narrativa e tre score per conversazione, interpreta gli score attraverso brevi istruzioni a fasce e aggiorna la continuità dopo il turno. La recente protezione contro snapshot troppo grandi affronta un difetto di persistenza. La separazione degli score dal contesto opzionale ne impedisce la perdita durante il taglio del prompt.

Queste proprietà tecniche non dimostrano il controllo della prosa. Il confronto esplorativo effettuato nel progetto ha mostrato differenze deboli o discontinue; non è uno studio statistico. Inoltre confrontare stati estremi con una card che descrive un primo incontro introduce un conflitto di contesto: è un utile stress test, ma va distinto da un normale scenario coerente con lo stadio della relazione.

Riferimenti locali: `packages/core/src/roleplay.ts`, `packages/core/src/roleplay-continuity.ts`, `packages/adapters/src/roleplay-executor.ts`, `apps/api/src/roleplay-relationship.ts`.

## Implementazioni open source

### Eros Engine: decisione prima della generazione

`decide()` produce un `ActionPlan` con azione, stile e modalità della risposta. La scelta fra risposta, silenzio e iniziativa precede il testo. I test controllano decisioni e soglie: non provano la qualità relazionale delle risposte. Fonte: [pde.rs](https://github.com/etherfunlab/eros-engine/blob/main/crates/eros-engine-core/src/pde.rs).

Il prompt builder traduce lo stato in direttive concrete. `roll_nudges()` applica prima esclusioni basate sullo stato, poi campiona alcune iniziative; il generatore riceve la scelta effettuata. `affinity_to_attitude_prompt()` e le regole di lunghezza trasformano lo stato in indicazioni espressive. È un esempio di controllo della decisione separato dalla formulazione. Non costituisce una garanzia di aderenza del testo; le particolari scelte di stile e prodotto non sono standard da importare. Fonte: [prompt.rs](https://github.com/etherfunlab/eros-engine/blob/main/crates/eros-engine-server/src/prompt.rs).

La documentazione distingue quattro assi accumulati e due dimensioni espressive derivate. Il giudice restituisce categorie ordinali; il motore gestisce calcolo, limiti e transizioni. Ci sono linee distinte di legame e chimica. Le formule e le soglie sono decisioni degli autori, non misure universali della relazione. Fonti: [affinity-model.md](https://github.com/etherfunlab/eros-engine/blob/main/docs/affinity-model.md), [affinity.rs](https://github.com/etherfunlab/eros-engine/blob/main/crates/eros-engine-core/src/affinity.rs).

### HerAndHim: il problema dei numeri senza comportamento

Nel codice gli autori descrivono la scarsa differenza fra relazione iniziale e avanzata quando venivano forniti soltanto numeri affettivi. La soluzione implementata combina trust e intimacy in fasce e le traduce in regole di voce: distanza iniziale, familiarità e scherzi, poi maggiore vulnerabilità. È un precedente diretto del nostro problema, ma il commento dell'autore non è una valutazione A/B pubblicata. Fonte: [agent.py](https://github.com/ericwang915/HerAndHim/blob/main/herandhim/core/agent.py#L1408).

La memoria emotiva e le dimensioni relazionali sono separate. Un limite del sistema esaminato è aggiornare il rapporto anche in base al sentiment negativo dell'utente: tristezza e sfiducia verso il personaggio non sono equivalenti. Per Rakazo serve riconoscere l'evento relazionale, non convertire automaticamente emozione negativa in perdita di fiducia. Fonte: [emotional_graph.py](https://github.com/ericwang915/HerAndHim/blob/main/herandhim/core/memory/emotional_graph.py).

### RisuAI e SillyTavern: controllo del contesto, non psicologia validata

RisuAI dispone di variabili persistenti nella chat, condizioni numeriche, trigger e punti di iniezione. HypaV3 conserva riferimenti ai messaggi e seleziona riassunti importanti, recenti e simili entro budget. Sono strumenti utili per attivare lo stato giusto e osservare i ricordi effettivamente inclusi; non dimostrano una progressione relazionale corretta. Fonti: [triggers.ts](https://github.com/kwaroran/Risuai/blob/main/src/ts/process/triggers.ts), [hypav3.ts](https://github.com/kwaroran/Risuai/blob/main/src/ts/process/memory/hypav3.ts).

SillyTavern offre priorità, gruppi esclusivi, posizione e budget delle informazioni, oltre a effetti sticky/cooldown/delay. Sono precedenze di attivazione, non garanzie sul testo. Un meccanismo simile potrebbe evitare di iniettare contemporaneamente due stadi contraddittori della relazione. Fonti: [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/), [world-info.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js).

### Separazione fra stato e istruzioni

Emotion Engine distingue baseline, mood, impulso emotivo, fiducia e memoria compatta, con stato legato alla relazione e gestione delle evidenze. Il protocollo non possiede una policy universale della risposta: questa resta nell'applicazione. Fonte: [protocollo](https://github.com/pioneerjeff-labs/emotion-engine/blob/main/docs/PROTOCOL.md).

Persona Engine compila modalità e cataloghi in blocchi stabili, con budget, precedenze e audit delle transizioni. Non interpreta il contenuto psicologico e non chiama un LLM. È un riferimento per versionare e rendere ispezionabili le istruzioni attive, non per una relazione che evolve da sola. Fonti: [repository](https://github.com/caty-ai/persona-engine), [SPEC](https://github.com/caty-ai/persona-engine/blob/main/SPEC.md).

## Evidenza accademica e relativi limiti

| Fonte primaria | Risultato o contributo utile | Limite per Rakazo |
|---|---|---|
| [Bickmore e Picard, TOCHI 2005](https://dam-prod.media.mit.edu/x/files/pdfs/04.bickmore-picard-tochi.pdf) | Studio randomizzato di un mese, 101 partecipanti iniziali: strategie relazionali migliorano gradimento, legame e desiderio di continuare. | Agente scripted e progressione prefissata; non valida score autonomi in un LLM. |
| [Skjuve et al., IJHCS 2022](https://doi.org/10.1016/j.ijhcs.2022.102903) | Interviste longitudinali a 25 nuovi utenti Replika per 12 settimane: sviluppo graduale ma variabile, con possibili rotture. | Osservazionale e qualitativo; non fornisce una formula universale di avanzamento. |
| [ALMA, AAMAS 2005](https://alma.dfki.de/papers/aamas05.pdf), [valutazione IVA 2006](https://alma.dfki.de/papers/iva06.pdf) | Personalità, mood ed emozione hanno scale temporali distinte. Una valutazione successiva coinvolge 33 persone su descrizioni di stati affettivi. | Architettura e plausibilità locale, non prova di relazioni LLM di lunga durata. |
| [Generative Agents, UIST 2023](https://arxiv.org/abs/2304.03442) | Memoria, recupero e riflessione contribuiscono alla credibilità in una simulazione sociale; ablation e giudizi di valutatori. | Simulazione breve: non equivale a companionship longitudinale con utenti. |
| [LongMemEval, ICLR 2025](https://arxiv.org/abs/2410.10813) | 500 domande su memoria multisessione, tempo, aggiornamenti e astensione. | Verifica recupero e ragionamento, non naturalezza o uso spontaneo appropriato dei ricordi. |
| [REMP, Findings EMNLP 2026](https://aclanthology.org/2026.findings-emnlp.602/) | Probe distinti di persona, emozione, memoria e continuità relazionale su traiettorie lunghe; 11 modelli. | Consultati pagina e abstract ufficiali; non verificato il testo completo. Non attribuiamo risultati di validazione umana non disponibili. |
| [Shaping personality, Nature Machine Intelligence 2025](https://www.nature.com/articles/s42256-025-01115-6) | Personalità sintetica condizionata con descrittori a più intensità; controllo simultaneo dei tratti più difficile del controllo singolo e dipendente dal modello. | Test prevalentemente psicometrici e generazione di status, in inglese; non dimostra controllo dell'intimità in dialoghi italiani. |
| [Personality Without Persons?, 2026](https://arxiv.org/abs/2607.02325) | Critica empirica alla trasferibilità dei Big Five umani agli LLM e alla struttura dei punteggi risultanti. | Non dimostra l'impossibilità di controllare personaggi; invita a validare il comportamento senza trattare score autoriali come misure di psicologia umana. |
| [MemoryBank, AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/29946) | Memoria recuperabile, riassunti di eventi e profilo aggiornato. | Test quantitativi su utenti virtuali e casi qualitativi non equivalgono a un trial umano longitudinale. |

La convergenza fra queste fonti è un supporto alla separazione dei componenti e alla valutazione, non una prova che una specifica combinazione di formule sia la soluzione ottimale.

## Ipotesi per Rakazo: uno stato strutturato, non una matrice indifferenziata

Questa sezione è una proposta originale da discutere e collaudare.

| Componente | Esempi | Proprietà desiderata |
|---|---|---|
| Fatti temporali | Primo incontro, ultimo contatto, episodi condivisi | Date e riferimenti reali alla storia; non uno score inventato di anzianità |
| Personalità canonica | Socievolezza, assertività, ironia, valori | Stabile; modifiche esplicite e versionate |
| Relazione per coppia | Familiarità, fiducia, affetto, attrazione | Stato durevole con eventi che motivano gli aggiornamenti |
| Stato momentaneo | Energia, umore, desiderio, tensione | Durata e rientro verso baseline separati dalla relazione |
| Situazione attuale | Stadio della relazione, impegni, conflitti aperti | Revisione esplicita dei fatti ormai superati |
| Piano del turno | Ascoltare, confidarsi, scherzare, proporre contatto | Scelta concreta compatibile con stato e contesto |
| Certezza dell'interpretazione | Evidenza forte, ambigua, mancante | Metadato distinto dalla sicurezza personale del personaggio |

Il numero può restare 0–100 o essere normalizzato internamente. Il tipo numerico non risolve il problema semantico; la precisione deve essere giustificata dalla capacità di misurare differenze. Un giorno trascorso non equivale automaticamente a fiducia acquisita.

### Evoluzione della memoria

Separare **scenario iniziale**, **cronologia degli episodi** e **stato attuale della relazione**. Il primo rimane un fatto di origine, ma non deve essere presentato come situazione ancora attuale dopo una svolta.

Ogni aggiornamento dovrebbe specificare: cosa è cambiato, in base a quali messaggi, da quando vale e quale descrizione precedente sostituisce. I riassunti sono interpretazioni ricostruibili, non l'unica fonte di verità. Gli episodi importanti rimangono recuperabili dopo la compressione.

Un override di debug cambia il comportamento richiesto, non crea retroattivamente appuntamenti, promesse o sentimenti dell'utente. Le fixture possono includere storie sintetiche coerenti; la conversazione reale conserva la propria storia.

### Compilare lo stato in un contratto comportamentale

Un turno potrebbe ricevere pochi campi risolti dal motore: intenzione, profondità della confidenza, grado di iniziativa, forme di affetto appropriate, ricordo pertinente e comportamenti incompatibili con la situazione.

La personalità modifica il modo di esprimere quel contratto. Un personaggio riservato e uno estroverso possono avere lo stesso affetto senza usare le stesse parole. Un personaggio molto legato può essere stanco: il legame rimane, mentre energia e lunghezza cambiano.

Le regole possono scegliere deterministicamente i comportamenti ammessi. La varietà entro quei limiti può essere campionata con un generatore riproducibile nei test. Il modello realizza la risposta; l'aderenza semantica va valutata, non presunta dalla presenza del campo nel prompt.

Per aggiungere un tratto servono più elementi del nome: definizione, estremi, interazioni con altri tratti, esempi contrastivi, regole di aggiornamento e casi di valutazione. Un livello visibile è una vista sullo stato, non necessariamente la sorgente di tutti gli assi.

### Aggiornamenti e stabilità

Il modello può riconoscere eventi e proporre categorie di cambiamento; il motore possiede limiti, transizioni, provenienza e idempotenza. Non dedurre una rottura dal fatto che l'utente sia triste. Non premiare la relazione perché il bot ha scritto da solo una frase affettuosa.

Le soglie di ingresso e uscita da uno stadio possono essere diverse, per evitare oscillazioni continue vicino al confine. Questa è una scelta ingegneristica da verificare, non una legge psicologica. Una svolta significativa può autorizzare un cambiamento maggiore di un turno ordinario.

## Esperimento proposto prima di un'implementazione ampia

1. **Baseline:** motore attuale, con prompt finale e memoria effettivamente inclusa registrati nelle fixture di test.
2. **Memoria aggiornata:** stessa baseline, distinguendo stato attuale e scenario iniziale. Isola il beneficio della coerenza narrativa.
3. **Contratto del turno:** aggiungere scelte comportamentali esplicite, mantenendo identici gli esempi fra tutte le condizioni. Isola il beneficio del controllo. L'effetto di esempi specifici per stadio richiede una successiva condizione separata.
4. **Combinazione:** memoria aggiornata e contratto, mantenendo modello e condizioni comparabili.

Tenere identici fatti della storia sintetica, messaggio dell'utente, personalità e cronologia nelle quattro condizioni; la rappresentazione della memoria varia soltanto dove previsto dal relativo trattamento. Valutare separatamente un contesto coerente e uno con descrizione relazionale superata o contraddittoria, preferibilmente incrociando entrambi con tutte le condizioni. Così la rimozione di un conflitto non viene scambiata per migliore controllo del comportamento.

Variare prima un asse solo, poi combinazioni miste: molto calore e poca confidenza; forte affetto e poca energia; forte fiducia senza attrazione. Trattare a parte lo stress test in cui uno stato forzato contraddice la card iniziale. Le fixture versionate devono essere sintetiche e non contenere conversazioni, memorie o credenziali reali degli utenti.

Usare scenari di sostegno, conflitto, noia, ironia, confidenza, proposta di attività, promessa mantenuta o mancata e ripresa dopo un intervallo. Ripetere campioni, controbilanciare l'ordine e mantenere fissi i parametri di generazione ove supportati. Registrare versione del modello, regole, stato, ricordi selezionati, costo e latenza.

Valutatori ciechi giudicano comportamento osservabile, non aggettivi contati: aderenza al livello, separazione degli assi, coerenza della persona, uso corretto della memoria, varietà e assenza di familiarità inventata. Le rubriche devono essere calibrate su esempi annotati e i casi ambigui risolti da revisione umana. Stabilire soglie di accettazione prima del confronto completo.

Tre proprietà da verificare separatamente:

- **Sensibilità:** cambiando uno stato rilevante, cambia il comportamento atteso.
- **Stabilità:** parafrasi o piccole variazioni irrilevanti non cambiano lo stadio o la personalità.
- **Continuità:** eventi, correzioni, compressioni e riavvii non riportano il personaggio all'inizio della relazione.

Una valutazione lunga con utenti resta distinta dal benchmark tecnico. Buona memoria, alto gradimento e controllo del livello non sono la stessa misura.

## Decisioni ancora aperte

- Definizione precisa di intimacy, love e desire e loro sovrapposizioni.
- Quali componenti sono autoriali, inferiti o modificabili nel debug.
- Precedenza delle istruzioni nelle card importate quando descrivono uno stadio superato.
- Quantità di livelli effettivamente distinguibili sui modelli locali e in italiano.
- Necessità di un planner LLM separato rispetto a regole più una sola generazione.
- Quale parte della progressione è comunicata all'utente e quali capacità espressive sblocca.

Non è stata avviata una nuova implementazione. Il prossimo passo proposto è definire rubriche e fixture per tre dimensioni, poi confrontare le quattro condizioni sopra; aggiungere nuove dimensioni solo quando l'effetto delle prime è misurabile.
