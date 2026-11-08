# HerAndHim: continuità quotidiana e confronto con Eros

Ricognizione del 29 ottobre 2026 sul commit [08bb1c2740eba1e7cfe25378ea1adca34a9b5568](https://github.com/ericwang915/HerAndHim/tree/08bb1c2740eba1e7cfe25378ea1adca34a9b5568). Analisi statica con tre agenti indipendenti: comportamento, fattibilità della prova e sicurezza. Nessun codice upstream eseguito, nessuna dipendenza installata, nessuna immagine scaricata. Circa 1,6 MB di sorgenti testuali consultati; esclusi modelli, cronologia Git e foto dimostrative.

## Lettura di prodotto

HerAndHim è un riferimento particolarmente vicino alla direzione di Rakazo per la **continuità della vita simulata del personaggio**. Eros è utile soprattutto come riferimento per la traduzione dello stato relazionale in comportamento. Questa distinzione indica i rispettivi punti di interesse, non un'esclusività: entrambi contengono più sottosistemi e nessuno dei due dimostra, da solo, una qualità conversazionale universale.

| Aspetto | HerAndHim: implementazione osservata | Implicazione per Rakazo |
|---|---|---|
| Giornata del personaggio | Piano con attività, luogo, città, meteo, abbigliamento e stato d'animo; la chat consulta lo slot corrente | Una fonte condivisa per «che fai?» e contesto delle foto |
| Ricorrenze e appuntamenti | Date strutturate, ricorrenze annuali, iniezione degli eventi vicini nel prompt | Affiancare dati temporali espliciti alla memoria narrativa |
| Contatto spontaneo | Scheduler con probabilità, orari di quiete e tetto giornaliero; conteggio delle iniziative senza risposta usato nel contesto conversazionale | Ritmo di contatto da valutare separatamente dal contenuto |
| Stile dei messaggi | Ritardi, risposte in più bolle, reazioni, attenzione alle assenze | Meccanismi implementati soprattutto nel canale Telegram |
| Foto | Descrizione dell'aspetto, seed stabile e immagine di riferimento riutilizzata dove il provider lo supporta | Condizionamento dell'identità, non garanzia misurata di coerenza |
| Personalità | Soul, persona, profilo e scelte di dinamica/tono | Separare identità relativamente stabile e stato del momento |

Fonti: [planner](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/scheduler/planner.py), [contesto della chat](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/agent.py#L1463), [date personali](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/personal_dates.py), [humanize](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/humanize.py), [selfie](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/image_gen/selfie.py).

## Cosa non prendere alla lettera

**Sentiment e relazione sono confusi.** L'analizzatore classifica il tono emotivo dell'utente; la formula usa quel risultato per aumentare o diminuire relationship_temperature, trust, intimacy e understanding. Uno sfogo negativo sul lavoro può quindi ridurre fiducia e intimità anche se esprime fiducia nel personaggio. I quattro valori sono inizializzati a 50 e limitati a 0–100. La media trust/intimacy attiva tre fasce di istruzioni: il collegamento al prompt esiste, ma la regola di aggiornamento va ripensata. [Analizzatore e aggiornamento](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/memory/emotional_graph.py), [fasce nel prompt](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/agent.py#L1520).

**Il livello visibile non è lo stato relazionale.** La dashboard calcola un bonding score separato da giorni attivi, numero di turni e milestone. Non va usato per verificare che l'affinità influisca sul modello. La UI permette di modificare identità, tono, dinamica e testi della persona, ma non espone un editor dei quattro valori numerici. [Calcolo nella dashboard](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/web/sanctum_api.py#L173).

**Web e Telegram non offrono la stessa prova.** Il codice prevede una chat browser indipendente da Telegram; non ne abbiamo verificato il funzionamento a runtime. L'avvio dello scheduler e la consegna dei messaggi spontanei sono collegati al canale Telegram. Aprire soltanto la dashboard non dimostra il ciclo quotidiano completo. [Avvio](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/main.py), [proactive](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/scheduler/proactive.py).

**Le fotografie dipendono dal provider.** Alcuni provider ignorano l'immagine di riferimento; ComfyUI può ricadere su text-to-image quando mancano i nodi richiesti. Il risultato `used_reference` non prova che il provider abbia realmente applicato il riferimento. Inoltre il percorso non cinese non aggiunge lo stesso blocco automatico attività/meteo/mood di quello cinese: da verificare esplicitamente in italiano. [Generazione](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/image_gen/generator.py), [prompt selfie](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/image_gen/selfie.py).

Altri punti da provare: ripetizione degli auguri senza un marcatore di ricorrenza già gestita; orari di quiete basati sul fuso della macchina anziché del personaggio; richiamo di emozioni negative trattato come argomento non concluso. È inoltre plausibile che le istruzioni sintetiche dei turni proattivi entrino nell'analisi emotiva anche quando vengono rimosse dalla cronologia: ipotesi da verificare a runtime, non difetto già riprodotto.

## Revisione prima dell'esecuzione

La normale dashboard richiede un intervento prima di essere aperta per una prova:

- Il rendering della galleria interpola metadati modificabili dal modello in HTML. Il percorso esaminato consente stored XSS: l'isolamento del container non protegge il browser da questo difetto. Servono costruzione sicura del DOM e validazione/codifica dei nomi dei file.
- `tools.runCommand=false` non blocca creazione e avvio di skill né l'installazione delle loro dipendenze. Per una prova senza esecuzione arbitraria occorre chiudere anche questi percorsi. In alternativa il container deve essere trattato come interamente controllabile dal modello.
- Le primitive di lettura/invio file sono ampie; la configurazione dell'app è leggibile dal processo e contiene i segreti. Usare soltanto credenziali sintetiche, nessun file host, home host o socket Docker.
- L'avvio Docker stampa il token della dashboard nei log. Non condividere o pubblicare quei log.
- Alcuni percorsi possono scaricare modelli per ricerca e voce. Disabilitare bot, provider opzionali, download automatici e rete non necessaria nella prima prova.

La revisione ha trovato autenticazione centralizzata su HTTP e WebSocket, cookie HttpOnly/SameSite e controllo dell'origine WebSocket. Queste difese non risolvono i problemi sopra. La revisione non certifica dipendenze, immagine pubblicata o corrispondenza binario/sorgente. Riferimenti: [tools](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/tools.py), [agent](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/core/agent.py), [galleria](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/web/static/index.html), [accesso](https://github.com/ericwang915/HerAndHim/blob/08bb1c2740eba1e7cfe25378ea1adca34a9b5568/herandhim/web/access.py).

## Prova proposta, distinta dall'integrazione

1. Correggere il rendering della galleria e bloccare tutti i percorsi di esecuzione/installazione delle skill nella configurazione di valutazione. Tenere documentate queste differenze dal sorgente upstream.
2. Usare la dashboard nativa su loopback in un ambiente separato, senza modificare Rakazo o la prova Eros. Database e file temporanei; UID non root, root filesystem in sola lettura, capability rimosse, limiti di risorse e accesso al modello attraverso destinazione fissa.
3. Configurare lo stesso modello della prova Eros tramite provider custom. La modalità senza ragionamento richiede un piccolo adattamento della richiesta: non è attualmente esposta dalla configurazione HerAndHim.
4. Provare prima identità, conversazione, ricorrenze e memoria; poi collegare lo scheduler a una consegna locale di test per osservare iniziativa e frequenza senza messaggi a persone reali. Non considerare una chat web isolata una prova della proattività.
5. Aggiungere, se richiesto per il confronto, un controllo dei quattro valori effettivi. Tenere separati stato relazionale, badge di engagement e personalità.
6. Provare le foto solo dopo aver scelto un endpoint: verificare identità, vestiti, luogo e orario della scena con un provider che supporti davvero le immagini di riferimento.

L'immagine pubblicata ispezionata è solo AMD64, con circa 330 MB di layer compressi e FFmpeg incluso. Prima di scaricarla è preferibile valutare una build ARM minimale senza extra voce/ricerca e senza FFmpeg. Nessun pacchetto va installato sull'host per questa prova.

## Ipotesi di composizione

La direzione da verificare è: **vita quotidiana e iniziativa ispirate a HerAndHim; stato e regole relazionali esplicite ispirate a Eros; gestione ispezionabile del contesto e lorebook ispirata a RisuAI/SillyTavern**. Non implica sommare tre motori completi. Rakazo dovrà conservare un solo stato autorevole e una sola orchestrazione del turno.
