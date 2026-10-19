# OEE Panel — Winding Machine MES

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

*Real-time OEE monitoring dashboard for transformer winding machines — lightweight, offline-first web app (vanilla JS + Firebase).*

Painel de produção e medição de **OEE** (Overall Equipment Effectiveness) para
máquinas de bobinagem de transformadores.

Roda direto no navegador, sem servidor, sem build e sem dependências externas.
Feito para ser aberto por duplo clique na máquina do operador, dentro da fábrica.

**Stack:** HTML + CSS + JavaScript puro (*classic scripts*), `localStorage`,
Firebase Realtime Database (opcional, para sincronizar vários PCs).

## Demonstração

🌐 **Online:** https://papaya-cannoli-ab3a0d.netlify.app

<!-- 🎬 Vídeo demo (~15 s de captura de tela real) — adicionar aqui quando estiver gravado -->

---

## Como abrir

**Opção 1 — duplo clique (recomendado para a fábrica)**

Clique duas vezes em `index.html`. Pronto.

**Opção 2 — servidor local (apenas para desenvolvimento)**

```bash
python -m http.server 8000
# depois abra http://localhost:8000
```

> O código usa *classic scripts* de propósito. ES Modules não carregam via
> `file://` (o navegador bloqueia por CORS), então abrir por duplo clique
> quebraria a tela em branco. O código está organizado em módulos mesmo assim.

---

## Usuários padrão (demonstração)

| Login | Senha | Perfil | Acesso |
|---|---|---|---|
| `operador` | `operador123` | Operator | Só a estação de trabalho |
| `gestor` | `gestor123` | Manager | Estação + Dashboard |
| `admin` | `admin123` | Admin | Tudo, incluindo Setup & Admin |

As senhas são guardadas como **hash SHA-256 com salt por usuário** — não dá para
ler a senha de volta, só redefinir. Troque-as antes de usar em produção:
*Setup & Admin → Manage Users*.

> Aviso: SHA-256 puro é adequado para um app 100% local, mas **não** substitui
> argon2/bcrypt em um sistema com servidor. Se um dia isto virar multi-usuário
> de rede, a autenticação precisa ir para um backend.

---

## O que o sistema faz

### Estação do operador
- Seleciona a máquina e acompanha o status (Standby / Running / Planned Stop / Unplanned)
- Painel grande para registrar o avanço: **Caixa → Camada 1 → … → Camada N → Finalizar**
- Aceita clique, `ESPAÇO`, `Enter` ou pedal de pé
- Bloqueio de 3 s após cada toque, para não registrar camadas em dobro
- Desfazer o último toque, retrabalho (voltar para uma camada), notas de turno e passagem de turno
- Parada com motivo: **não planejada** (ataca a disponibilidade) ou **planejada** (não ataca)
- **Histórico único** com os passos de fabricação **e todas as paradas**: início, fim,
  duração, motivo e selo `PLANNED` / `UNPLANNED`

### Dashboard
- KPIs: OEE, Disponibilidade, Performance, Qualidade, MTBF, MTTR
- **OEE fica vermelho** quando está abaixo do OEE Target configurado
- **Tabela de rastreamento de paradas**: máquina, motivo, tipo, início, fim, duração e operador,
  com resumo de paradas programadas vs. não programadas
- Pareto de paradas não planejadas
- Tempos médios aprendidos automaticamente por tipo de transformador
- Tabela de máquinas ao vivo

### Setup & Admin (somente admin)
- Cadastro de modelos de transformador, motivos de parada e máquinas
- Usuários e perfis
- **Configurações de produção**: OEE Target, modo de Performance, cooldown,
  retenção do histórico, **início e duração do turno**
- Conexão opcional com Firebase para sincronizar vários PCs

---

## Como o OEE é calculado

```
OEE = Disponibilidade × Performance × Qualidade
```

Existem **duas janelas**, de propósito:

| Janela | Onde | Denominador | Perda registrada |
|---|---|---|---|
| **Turno atual** | Estação e *Current Shift* no Dashboard | **duração fixa do turno** | **permanente** |
| Dia / Semana / Mês / 12 meses | seletor de período do Dashboard | tamanho da janela | pode diluir ao longo dos dias |

### O OEE do turno NÃO se cura

O turno é a **unidade de responsabilidade**. O denominador é a duração fixa do
turno, e cada perda é um débito permanente em segundos:

```
Disponibilidade = 1 − segundosNãoPlanejados / duraçãoDoTurno
Performance     = 1 − segundosAcimaDoPadrão / duraçãoDoTurno
Qualidade       = 1 − segundosDeRetrabalho   / duraçãoDoTurno
```

Como cada parcela de perda **só cresce** dentro do turno, todos os KPIs são
**monotônicos**: só podem cair ou ficar parados. Produzir mais **não** empurra
o número de volta para 100% só porque a produção continuou.

> **Por que isso importa.** As fórmulas clássicas usam um denominador que
> cresce a cada segundo de produção:
> `Disponibilidade = rodando / (rodando + parado)` e
> `Qualidade = boas / (boas + refeitas)`. Com elas, uma perda às 8h já tinha
> se dissolvido sozinha às 17h, e o turno "sarava". Medindo contra a duração
> fixa do turno, uma perda registrada às 8h continua totalmente visível às 17h.
>
> Num turno em que a produção preenche a janela, os dois modelos convergem:
> `segundosDeRetrabalho / duraçãoDoTurno ≈ defeitos / peças`. A diferença
> aparece exatamente quando a produção continua depois da perda — que é o caso
> que queremos medir.

O turno é uma grade de duração fixa ancorada em **Shift start hour**
(*Production Settings*), ex.: início 6h e 8h de duração → turnos 6h–14h,
14h–22h, 22h–6h. A duração aceita **valor decimal** em passos de 0,5 h: para
um turno de 8h30, digite `8.5`. Máquina em *Standby* não conta como perda, e
parada planejada também não.

### Performance

Compara o tempo real de cada passo com o **tempo padrão do modelo**. No turno,
os segundos gastos **acima** do padrão são a perda:

```
Performance = 1 − Σ(max(0, tempoReal − tempoPadrão)) / duraçãoDoTurno   (limitado a 100%)
```

Bater o padrão não gera crédito; só o excesso de tempo conta contra o turno.

Dois modos, em *Setup & Admin*:

- `LEARNED` — **padrão**. Compara com o tempo padrão do modelo.
- `FIXED_100` — sempre 100%, nunca penaliza.

Sem nenhum passo concluído ainda, o Performance mostra `—` em vez de um
`100%` enganoso.

### Tempo padrão: AUTO

Em *Setup & Admin → Register Transformer Model* há **Std Box (s)** e
**Std Layer (s)**.

- **`0` = AUTO** — o motor calibra o padrão com a **média real medida** daquele
  modelo, a partir de 5 passos concluídos. É o padrão recomendado: uma linha
  que leva 10 s por camada se auto-ajusta em poucos passos.
- **Número explícito** — sobrescreve o automático.

A coluna **In use** mostra o padrão que o motor está usando naquele momento
(`auto 10s`, `600s`, `600s (fallback)`). Sem ela é fácil achar que o padrão
está errado quando na verdade o AUTO ainda está calibrando.

> Performance é limitado a 100%: bater o padrão não gera crédito. Se o KPI
> estiver preso em `100%`, o aviso abaixo dele dirá *"Beating the standard"* —
> é sinal de que o padrão está alto demais, não de que o cálculo falhou.

**Qualidade** debita o tempo padrão das camadas que voltaram para retrabalho.
É um débito de mão única: refazer as camadas conserta o transformador, mas o
turno não "recupera" o crédito — a perda continua contando, como deveria.

**MTBF / MTTR** só aparecem depois da primeira falha não planejada. Sem
falhas registradas eles mostram `—`, em vez de um número inventado.

**Meta (Target).** O número de OEE é colorido automaticamente: **verde** acima
do OEE Target, **vermelho** abaixo. Ajuste a meta em *Production Settings*.

---

## Changeover entre transformadores

Ao finalizar um transformador a máquina entra em **Setup / Changeover** com
status **PLANNED** — é uma parada conhecida e consciente, e não é cobrada
contra a Disponibilidade.

O evento é gravado normalmente (motivo `Setup / Changeover`, com início, fim e
duração), então dá para construir um KPI de changeover sobre o histórico
existente sem retrocompatibilidade — basta somar `STOP_PLANNED` onde o motivo
for esse.

Na lista de motivos de parada em *Setup & Admin*, `Setup / Changeover` também
já vem classificado como **programada**.

> Classificação atual: `PLANNED`. Está nos planos criar um KPI dedicado de
> changeover e reavaliar essa classificação.

---

## Histórico de paradas

Toda parada — **programada ou não** — vira um registro no banco com:

| Campo | Conteúdo |
|---|---|
| `startTime` | instante em que a máquina parou |
| `endTime` | instante em que ela voltou |
| `durationSec` | duração em segundos |
| `reason` | motivo selecionado |
| `stopType` | `PLANNED` ou `UNPLANNED` |

Esses registros aparecem em três lugares:

1. **Estação → Layer History**, com selo colorido e o intervalo `14:32 → 15:07`
2. **Dashboard → Downtime Tracking**, tabela completa por máquina
3. **Export CSV**, nas colunas `Start_Time`, `End_Time`, `Reason` e `Event_Type`

Paradas planejadas aparecem em todos eles por rastreabilidade, mas só as não
planejadas entram no cálculo de Disponibilidade.

---

## Configurações

Em *Setup & Admin → Production Settings*:

| Campo | Padrão | Para quê |
|---|---|---|
| OEE Target (%) | 85 | Meta; o OEE fica vermelho abaixo dela |
| Performance Mode | `LEARNED` | Se a performance é calculada ou fixa |
| Cooldown (s) | 3 | Tempo de bloqueio após cada toque no painel |
| Retenção (dias) | 180 | Quanto tempo o histórico é guardado |
| Shift start hour | 6 | Hora de início da grade de turnos |
| Shift length (h) | 8 | Duração de cada turno (aceita decimal, ex.: `8.5`) |

knobs técnicos (intervalos, limite de eventos, delimitador do CSV) ficam em
`js/config.js`.

---

## Sincronização entre PCs

Três níveis:

1. **localStorage** — salva neste PC
2. **BroadcastChannel / evento `storage`** — outras abas do mesmo PC
3. **Firebase Realtime Database** — outros PCs da fábrica (opcional)

Para ligar o nível 3: crie um Realtime Database em
[console.firebase.google.com](https://console.firebase.google.com), copie a URL
e cole em *Setup & Admin* → **Connect Realtime Cloud**. A URL fica salva e a
sincronização volta sozinha depois de recarregar a página em qualquer PC.

### Status visível

O estado da nuvem fica sempre à vista, em dois lugares:

- **Badge no topo** (ao lado das abas): `Local sync only` (cinza/verde),
  `Connecting…` / `Syncing…` (âmbar pulsando), `Synced HH:MM:SS` (ciano) ou
  `Cloud error` (vermelho).
- **Linha de status no card Firebase** (Setup & Admin), com a hora do último
  sync ou a mensagem de erro.

### Como os dados se juntam (merge, não sobrescrita)

Um *pull* não substitui mais o banco inteiro — ele **mescla** o que está na
nuvem com o que está neste PC, para que nenhum PC perca trabalho:

| Coleção | Regra de merge |
| --- | --- |
| `events` / `notes` | união por `id` (log append-only: nada é perdido) |
| `machines` | por código: vence o lado com a atividade mais recente |
| `settings`, `users`, `models`, `stopReasons` | último a escrever, e só quando o conteúdo muda |

`updatedAt` é a versão do merge e só avança quando algo realmente mudou, então
dois PCs convergem em um passo extra em vez de ficar se sobrescrevendo. Se dois
operadores controlarem a **mesma máquina** ao mesmo tempo, o estado dessa
máquina (camada atual, status) segue o PC que agiu por último — os eventos dos
dois são preservados, mas o ideal é um PC por máquina.

### ⚠️ Segurança do Firebase

Um banco criado em **Test Mode** aceita leitura e escrita de **qualquer pessoa**
que tenha a URL — inclusive desconhecidos. Antes de colocar dados reais de
produção, proteja o banco.

Como o app é puramente front-end (sem servidor para validar login), não há
como fazer autenticação "de verdade" só com as regras do Realtime Database.
Os caminhos realistas são:

- **Firebase App Check** — bloqueia acessos vindos de fora do seu app/site;
- **manter o sistema 100% local** (sem Firebase) em plantas com dados sensíveis.

Se a URL do banco vazar, os dados de produção vazam junto. Na dúvida, rode local.

---

## Estrutura

```
oee-panel-winding/
├── index.html              # só a estrutura
├── README.md
├── LICENSE
├── .gitignore
├── css/
│   ├── tokens.css          # cores, espaçamentos, tipografia (variáveis)
│   └── styles.css          # componentes, layout, responsivo
├── js/
│   ├── config.js           # constantes + dados iniciais
│   ├── utils.js            # DOM, escapeHtml, formatação, toasts
│   ├── crypto.js           # SHA-256 e hash de senha
│   ├── storage.js          # localStorage, migração, podagem
│   ├── sync.js             # abas + Firebase
│   ├── events.js           # registro de eventos
│   ├── metrics.js          # motor de OEE
│   ├── machines.js         # registro de máquinas
│   ├── auth.js             # login e permissões
│   ├── export.js           # CSV
│   ├── main.js             # bootstrap, navegação, teclado, heartbeat
│   └── views/
│       ├── station.js      # tela do operador
│       ├── dashboard.js    # indicadores
│       └── setup.js        # administração
└── tests/
    └── smoke-test.js       # 275 verificações automatizadas
```

Todos os módulos registram em um único objeto global `window.OEE`, sem
dependência entre arquivos além dessa ordem de carregamento.

---

## Testes

```bash
npm install jsdom
node tests/smoke-test.js
```

275 verificações automatizadas cobrindo login e permissões, o fluxo de produção
completo, undo, retrabalho, paradas planejadas e não planejadas, cálculo de
OEE, configurações, XSS, migração de dados e performance.

---

## Notas de implementação

**Por que não há `innerHTML` para dados de usuário?** Tudo que vem de digitação
(nome da máquina, número de série, motivo de parada, nota de turno) é escrito
com `textContent` ou escapado. Botões usam `data-action` com delegação de
evento, em vez de `onclick="funcao('valor')"` — interpolar texto do usuário
num atributo HTML permite injeção de código.

**Por que SHA-256 em JS puro?** `crypto.subtle` só existe em contexto seguro
(https/localhost). Abrindo o arquivo por `file://` não existe, então o app
levaria um hash embaixo. A implementação está em `js/crypto.js` e é validada
contra os vetores oficiais do NIST.

**Limite de histórico.** `db.events` é podado por idade e por quantidade
(`config.tech.maxEvents`). Sem isso o `localStorage` enche e o navegador passa
a lançar `QuotaExceededError` — o app agora trata esse erro em vez de travar.

**Modais.** O backdrop que escurece a tela só fecha o diálogo quando o clique
acontece **no próprio backdrop**. Clicar em qualquer campo ou botão dentro do
diálogo não fecha — o caso comum de "o modal fecha sozinho ao preencher".

**Encoding.** Todos os arquivos são UTF-8 **sem BOM**. O `<meta charset="UTF-8">`
precisa ser a primeira coisa dentro do `<head>`. Se você editar esses arquivos
com ferramentas que gravam em ANSI (o PowerShell 5.1 é uma delas), os acentos e
os emojis viram lixo — rode um teste de encoding antes de commitar.

---

## Licença

MIT — veja o arquivo [LICENSE](LICENSE).
