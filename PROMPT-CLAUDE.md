# Prompt pra Claude Code configurar este Command Center

> Cole o conteúdo abaixo no Claude Code (com este repo aberto) e ele vai te pedir as info necessárias e configurar tudo automaticamente.

---

## 📋 Cole este prompt:

```
Olá Claude! Acabei de clonar o "Trello Command Center" e quero adaptar pro meu projeto.

Por favor:

1. Lê o README.md e o SETUP.md pra entender o que é

2. Me pergunta as seguintes infos (uma por uma):
   - Nome do meu projeto
   - Ícone (emoji) do projeto
   - URL do board Trello (vou colar tipo https://trello.com/b/abc12345/meu-board)
   - Repos GitHub que devem ser sincronizados (lista de "org/repo")
   - Lista de pessoas no time: nome, papel, nome no Trello, login GitHub
   - EPICs do meu projeto (prefixos que aparecem nos títulos dos cards, tipo [INFRA], [API], [UI]) com nome completo, prioridade (P0-P3) e ícone

3. Com isso, monta o config.json substituindo o config.example.json

4. Me ajuda a gerar:
   - API Key + Token do Trello (me dá as URLs e instruções pra clicar)
   - Personal Access Token GitHub (me dá URL e os scopes necessários)

5. Cria o .env local com as creds que eu fornecer

6. Roda `node refresh.js` pra confirmar que puxa o board

7. Me explica como deployar no Netlify (passo-a-passo do SETUP.md)

8. Quando eu confirmar que deployou, configura as 4 env vars no Netlify via API
   (vou te passar o NETLIFY_AUTH_TOKEN gerado em https://app.netlify.com/user/applications)

9. Adiciona os secrets do GitHub Actions pra auto-refresh funcionar

10. Faz um teste E2E pra confirmar que tudo tá funcionando

11. Me dá a URL final + secret pra eu compartilhar com meu time

Se em qualquer passo eu travar (não souber onde clicar, errar credencial), me oriente
com prints, screenshots ou link direto. Aja com autonomia: se você consegue fazer
algo sem precisar perguntar, faça.

Não toque em arquivos fora deste repo (não modifique meu Git config global, não
suba nada pra repos meus sem confirmar nome).

Pode começar.
```

---

## 🔑 Tokens que vão ser pedidos durante o setup

Tem 3 momentos onde Claude vai te pedir credenciais:

### 1. Trello API Key + Token
- **Quando:** logo no início, pra puxar board
- **Como:** Claude te dá link `https://trello.com/power-ups/admin` e te guia
- **Onde fica:** `.env` local (gitignored) e env vars do Netlify

### 2. GitHub Personal Access Token (PAT)
- **Quando:** pra puxar PRs dos teus repos
- **Como:** https://github.com/settings/tokens → "Generate new token (classic)"
- **Scopes:** `repo`, `read:org`
- **Onde fica:** secrets do GitHub Actions (não vai pro código)

### 3. Netlify Personal Access Token
- **Quando:** pra Claude criar o site/configurar env vars sozinho
- **Como:** https://app.netlify.com/user/applications#personal-access-tokens
- **Onde fica:** só na sessão Claude (não persistente)

---

## ⚠️ Avisos

- **Não compartilhe esses tokens em chat público / repo público.** Os tokens dão acesso total às tuas contas.
- **Repo deve ser privado** se o config tiver dados sensíveis do time
- **Site Netlify é público por padrão** — qualquer um com URL acessa. Pra restringir use Netlify Identity ou Cloudflare Access.

---

## 💡 Setup manual (sem Claude)

Se preferir fazer manual, segue [SETUP.md](SETUP.md). É o mesmo processo, só sem automação.
