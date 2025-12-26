# 🚀 Guia de Deploy - Sistema de Gestão de Comissões

## Deploy Rápido na Nuvem

### Opção 1: Railway (Recomendado - Mais Fácil)

1. **Acesse**: https://railway.app
2. **Faça login** com GitHub
3. **Novo Projeto**: "New Project" → "Deploy from GitHub repo"
4. **Selecione** este repositório
5. **Railway detecta automaticamente** Node.js
6. **Deploy automático** - pronto para usar!

**Vantagens Railway:**
- ✅ Deploy automático
- ✅ SSL gratuito
- ✅ Banco SQLite persistente
- ✅ 500 horas grátis/mês
- ✅ URL pública automática

---

### Opção 2: Render

1. **Acesse**: https://render.com
2. **Novo Web Service**: "New" → "Web Service"
3. **Conecte** repositório GitHub
4. **Configurações**:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. **Deploy**

**Vantagens Render:**
- ✅ 750 horas grátis/mês
- ✅ SSL automático
- ✅ Deploy automático

---

### Opção 3: Fly.io

1. **Instale Fly CLI**:
```bash
curl -L https://fly.io/install.sh | sh
```

2. **Login**:
```bash
fly auth login
```

3. **Na pasta do projeto**:
```bash
fly launch
```

4. **Configure**:
   - Nome do app
   - Região (escolha próxima)
   - Confirme

5. **Deploy**:
```bash
fly deploy
```

**Vantagens Fly.io:**
- ✅ Totalmente gratuito para projetos pequenos
- ✅ Deploy global
- ✅ Controle total

---

## 📦 Preparação dos Arquivos

Antes do deploy, certifique-se que tem:

```
commission-system/
├── server.js           ✅
├── package.json        ✅
├── public/
│   └── index.html     ✅
├── README.md          ✅
└── exemplo-nfe.xml    ✅
```

---

## 🔧 Variáveis de Ambiente (Opcional)

Se necessário, configure:

```env
PORT=3000
NODE_ENV=production
```

---

## ✅ Checklist de Deploy

- [ ] Código commitado no GitHub
- [ ] package.json correto
- [ ] Porta dinâmica (process.env.PORT)
- [ ] Plataforma escolhida
- [ ] Deploy realizado
- [ ] URL testada

---

## 🧪 Testar Localmente Primeiro

Se quiser testar localmente (requer Node.js instalado):

```bash
# Instalar dependências
npm install

# Iniciar servidor
npm start

# Acessar
http://localhost:3000
```

---

## 📊 Monitoramento

Após deploy:

1. **Teste a URL** fornecida pela plataforma
2. **Importe um XML** de teste
3. **Verifique** se títulos foram criados
4. **Crie um pedido** de teste
5. **Confirme** persistência de dados

---

## 🐛 Problemas Comuns

### "Cannot find module"
- Solução: Verifique package.json
- Execute: `npm install`

### "Port already in use"
- Solução: Use porta dinâmica
- Código já usa: `process.env.PORT || 3000`

### "Database locked"
- Solução: SQLite em produção usa arquivo
- Railway/Render persistem automaticamente

### Upload não funciona
- Solução: Pasta `uploads/` criada automaticamente
- Permissões corretas no servidor

---

## 💡 Dicas de Produção

1. **Backup do Banco**
   - Download periódico do `commission.db`
   - Export para JSON/CSV

2. **Logs**
   - Railway: aba "Deployments" → "View Logs"
   - Render: aba "Logs"
   - Fly.io: `fly logs`

3. **Escalabilidade**
   - Sistema suporta múltiplos usuários
   - SQLite adequado para até 10 usuários simultâneos
   - Para mais: migrar para PostgreSQL

---

## 🎯 Próximos Passos

Após deploy bem-sucedido:

1. ✅ Compartilhe URL com equipe
2. ✅ Teste com XML real
3. ✅ Configure backup automático
4. ✅ Documente processos internos
5. ✅ Treine usuários

---

## 📞 Suporte

Problemas com deploy?

1. Verifique logs da plataforma
2. Teste localmente primeiro
3. Confira documentação da plataforma:
   - Railway: https://docs.railway.app
   - Render: https://render.com/docs
   - Fly.io: https://fly.io/docs

---

## 🔐 Segurança em Produção

- [ ] Adicione autenticação (futuro)
- [ ] Configure CORS se necessário
- [ ] Use HTTPS (automático nas plataformas)
- [ ] Limite tamanho de upload
- [ ] Validação de XMLs

---

Boa sorte com o deploy! 🚀
