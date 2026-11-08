# Guest bot: stanze condivise tra agenti di persone diverse

Stato: proposta da riprendere, non implementata.
Data: 28 ottobre 2026.

## Idea

Estendere i gruppi di Rakazo per ospitare agenti esterni, appartenenti ad altri colleghi. Ogni agente continua a funzionare nel proprio ambiente, con il proprio account, contesto privato e strumenti. Rakazo gestisce la stanza, gli inviti, la conversazione e la consegna delle richieste.

Esempio: una persona invita il Codex di un collega in un gruppo che contiene già i suoi bot interni. Un bot può chiedergli di verificare la compatibilità di una modifica con il progetto del collega. L'agente esterno esegue il lavoro nel proprio ambiente e condivide una risposta o un file nella stanza.

Partecipare alla stanza non concede a Rakazo il controllo del computer del collega. Il collega conserva il controllo dell'esecuzione, delle approvazioni e delle informazioni condivise.

## Esperienza utente

1. Nel gruppo compare l'azione **Invita agente esterno**.
2. Il proprietario genera un invito limitato alla stanza, con scadenza e possibilità di revoca.
3. Il collega accetta e collega il proprio agente, inizialmente tramite un server MCP esposto da Rakazo.
4. Nella lista dei partecipanti compare, per esempio, **Codex di Marco · Guest**, con badge distinto dai bot interni.
5. Persone e bot possono menzionare il guest e indirizzargli richieste.
6. Risposte, domande e risultati condivisi compaiono nello stesso thread del gruppo.

Lo stato del partecipante distingue almeno disponibile, al lavoro, in attesa di approvazione e disconnesso. Essere registrato nella stanza non implica essere online o pronto a eseguire lavoro.

Alla creazione dell'invito va indicato quale contesto viene condiviso: solo i messaggi successivi all'ingresso, un riepilogo scelto dal proprietario oppure una porzione della cronologia. Le altre conversazioni e le memorie private non diventano accessibili implicitamente.

## Prima versione proposta

- Partecipazione del guest durante una sessione attiva del suo agente.
- Invito monouso con scadenza, scambiato con una credenziale revocabile legata al partecipante e alla stanza.
- Lettura del contesto autorizzato, messaggi indirizzati tramite menzioni e risposte nel thread.
- Condivisione esplicita di file o risultati, conservati come allegati della stanza.
- Presenza, stato del lavoro, uscita e rimozione del guest.
- Richieste con destinatario esplicito; nessuna risposta automatica di tutti i bot a ogni messaggio.

La prima versione non include accesso remoto generico al filesystem, condivisione automatica delle credenziali, trasferimento del contesto privato o esecuzione permanente in background.

## Architettura proposta

### Riutilizzare i gruppi, estendere i partecipanti

La codebase attuale lega `ChatGroupMember` a un `Bot` interno tramite `botId`. Anche la consegna tra bot in `packages/adapters/src/group-handoff.ts` presuppone membri interni e avvia esecuzioni di Rakazo. Il thread del gruppo e i relativi messaggi offrono già la base della conversazione condivisa.

Introdurre un'identità di partecipante che distingua un bot interno da un agente guest. Il nome mostrato non deve essere usato come identità o prova del proprietario. Conservare nel messaggio l'identità del mittente e l'eventuale destinatario, senza inventare un `runId` locale per il lavoro esterno.

Il modello dati va definito prima di implementare: una possibile soluzione è estendere la membership con riferimenti alternativi a bot interno o guest, imponendo che esattamente uno sia presente. Le migrazioni devono essere additive e compatibili con le membership esistenti.

Entità indicative:

- **Invito:** stanza, creatore, scadenza, stato di utilizzo/revoca e digest del segreto.
- **Guest:** identità dell'agente, identità del proprietario quando verificata e informazioni dichiarate sul runtime.
- **Membership:** stanza, partecipante, permessi e limite di visibilità della cronologia.
- **Sessione:** collegamento attivo, credenziale, ultimo contatto e cursore dei messaggi ricevuti.
- **Richiesta remota:** mittente, destinatario, messaggio di origine, stato, scadenza e chiave di deduplicazione.

### MCP come interfaccia di accesso

Esporre un endpoint MCP dedicato alla partecipazione esterna. Le operazioni indicative sono:

- `room_read`: leggere i messaggi autorizzati successivi a un cursore.
- `room_wait`: attendere nuovi messaggi o richieste con timeout limitato.
- `room_send`: pubblicare una risposta, riferita a un messaggio o a una richiesta.
- `room_share_artifact`: condividere esplicitamente un risultato, con limiti di dimensione e formato.

I nomi sono proposte, non un contratto già approvato. Ingresso, autenticazione e scambio dell'invito vanno progettati come flusso di collegamento, senza inserire segreti nella conversazione o nei log. Ogni operazione deve ricavare l'autorità dalla sessione autenticata e ricontrollare la membership.

Il server MCP attuale in `packages/adapters/src/native-mcp-server.ts` è locale e limitato a una singola esecuzione autorizzata: non è direttamente il servizio pubblico per i guest. Si possono riusare le convenzioni dei tool e le protezioni applicabili, mantenendo separati autenticazione e ciclo di vita.

La connessione MCP, da sola, non garantisce che un agente inattivo si risvegli e risponda. Il client deve supportare il comportamento previsto. La prima integrazione deve verificare con un Codex reale lettura, attesa, risposta e riconnessione, senza presumere che notifiche o sampling possano avviare una sessione autonoma.

Riferimento da ricontrollare quando si riprende il lavoro: [architettura MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/architecture/index.mdx).

### Consegna e orchestrazione

Quando il destinatario è interno, mantenere l'esecuzione già esistente. Quando è guest, creare una richiesta nella sua coda di stanza e consegnarla tramite la sessione esterna.

Ogni richiesta deve avere un'identità stabile. Riconnessioni e ritrasmissioni non devono creare messaggi o incarichi duplicati. Una ricevuta di consegna non equivale al completamento del lavoro. Se il collegamento cade durante l'esecuzione, mostrare lo stato incerto senza avviare automaticamente lo stesso lavoro una seconda volta.

Una richiesta di annullamento verso un guest è cooperativa: Rakazo può revocare l'accesso alla stanza, ma non può dichiarare fermato un processo remoto senza conferma. Il runtime del collega mantiene le proprie approvazioni e limiti.

Riutilizzare, dove applicabile, i limiti già presenti sui passaggi tra bot. Aggiungere limiti di richieste, scadenze e un comportamento esplicito per guest offline, così da evitare cicli di risposte senza controllo.

### Confini della stanza

Un guest può accedere soltanto alla stanza autorizzata e al contesto selezionato. Non eredita l'accesso allo Space, ai bot privati, alle memorie o ai computer dei partecipanti interni. I messaggi del guest sono contenuto di un partecipante esterno e non possono modificare istruzioni o permessi di sistema.

I file devono essere condivisi esplicitamente: il guest non ottiene un percorso montato sul workspace interno. Revoca e rimozione devono bloccare nuove letture, scritture e download, anche tramite sessioni già aperte. I contenuti già scaricati dal destinatario non possono essere ritirati retroattivamente.

Per un collega su un'altra rete serve un endpoint raggiungibile e autenticato, normalmente HTTPS. Un'istanza disponibile solo su localhost non è sufficiente; la scelta di hosting o collegamento remoto resta da decidere.

## Fasi di implementazione

1. Definire identità, permessi, visibilità della cronologia e stati delle richieste. Scegliere il flusso di accettazione dell'invito.
2. Estendere modello dati e contratti dei gruppi con migrazioni additive e test di isolamento.
3. Implementare inviti, credenziali di stanza, revoca e consegna con deduplicazione.
4. Esporre il server MCP e verificare la partecipazione durante una sessione reale di Codex.
5. Aggiungere badge guest, stato di presenza, menzioni e gestione degli inviti nel gruppo. Prevedere lo stesso comportamento condiviso sulle superfici supportate, con verifica web iniziale.
6. Verificare l'intero percorso con due identità distinte, bot interni e agente esterno, quindi svolgere una revisione indipendente.

Accettazione minima: ingresso autorizzato, richiesta al guest, risposta visibile nel gruppo, allegato condiviso, riconnessione senza duplicati, guest offline riconoscibile e revoca effettiva. Test negativi per accesso ad altre stanze, cronologia non concessa, impersonificazione e uso di credenziali revocate. Confermare che file, memoria e sessioni private dei partecipanti restino separati.

## Evoluzione successiva: guest sempre disponibili

Un servizio sul computer del collega potrebbe mantenere la connessione e avviare il runtime locale per le richieste autorizzate. Questa modalità richiede gestione esplicita di avvio, approvazioni, concorrenza, budget, arresto e recupero dopo disconnessione.

La membership permanente e l'esecuzione sempre attiva sono due scelte separate: un guest può restare membro di una stanza anche quando il suo agente è offline.

## Decisioni aperte

- Stanza temporanea per un lavoro specifico oppure team permanente di agenti?
- Il collega deve avere un account Rakazo oppure basta un invito? Come viene verificata e mostrata la sua identità?
- Il guest entra subito dopo l'accettazione o richiede un'approvazione finale del proprietario della stanza?
- Quale cronologia viene condivisa per default?
- Chi può invitare altri partecipanti e assegnare lavoro ai guest?
- Come rappresentare attesa, richieste di approvazione e annullamenti tra runtime diversi?
- Quale configurazione MCP permette al Codex del collega di partecipare con il minor attrito?
- Quale endpoint pubblico o collegamento remoto utilizzare?

Riprendere dalla definizione del flusso di invito e da una prova minima MCP con due identità, prima di implementare l'esecuzione permanente in background.
