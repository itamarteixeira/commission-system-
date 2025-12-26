# 💼 Sistema de Gestão de Comissões

Sistema completo para gestão de comissões baseado em importação de XML de notas fiscais eletrônicas (NF-e).

## 🚀 Funcionalidades

### ✅ Implementadas

1. **Importação de XML**
   - Upload de arquivos XML de NF-e
   - Extração automática de dados da nota
   - Validação de chave de acesso (evita duplicatas)
   - Percentual de comissão configurável

2. **Gestão de Títulos**
   - Geração automática de títulos por duplicata
   - Cálculo automático de valores de comissão
   - Visualização completa de títulos
   - Status dos títulos (pendente, em pedido)
   - Seleção múltipla para criar pedidos

3. **Gestão de Pedidos**
   - Criação de pedidos agrupando títulos
   - Visualização de detalhes do pedido
   - Lista de títulos incluídos
   - Cálculo automático de valores

4. **Dashboard**
   - Estatísticas gerais do sistema
   - Total de notas importadas
   - Total de comissões geradas
   - Títulos pendentes
   - Valor total de pedidos

5. **Notas Fiscais**
   - Histórico de notas importadas
   - Detalhes de emitente e destinatário
   - Valores e datas

## 📋 Requisitos

- Node.js 14 ou superior
- NPM ou Yarn

## 🔧 Instalação

1. Instale as dependências:
```bash
npm install
```

2. Inicie o servidor:
```bash
npm start
```

3. Acesse o sistema:
```
http://localhost:3000
```

## 📊 Estrutura do Banco de Dados

### Tabela: notas_fiscais
- `id`: ID único
- `numero_nota`: Número da NF-e
- `serie`: Série da nota
- `data_emissao`: Data de emissão
- `chave_acesso`: Chave de acesso da NF-e (única)
- `emitente_nome`: Nome do emitente
- `emitente_cnpj`: CNPJ do emitente
- `destinatario_nome`: Nome do destinatário
- `destinatario_cnpj`: CNPJ do destinatário
- `valor_total`: Valor total da nota
- `xml_completo`: XML completo armazenado
- `data_importacao`: Data da importação

### Tabela: duplicatas
- `id`: ID único
- `nota_fiscal_id`: Referência à nota fiscal
- `numero_duplicata`: Número da duplicata
- `valor`: Valor da duplicata
- `vencimento`: Data de vencimento

### Tabela: titulos_comissao
- `id`: ID único
- `duplicata_id`: Referência à duplicata
- `nota_fiscal_id`: Referência à nota fiscal
- `percentual_comissao`: Percentual aplicado
- `valor_comissao`: Valor calculado da comissão
- `status`: Status do título (pendente, em_pedido)
- `pedido_id`: Referência ao pedido (se aplicável)
- `data_criacao`: Data de criação

### Tabela: pedidos
- `id`: ID único
- `descricao`: Descrição do pedido
- `valor_total`: Valor total do pedido
- `quantidade_titulos`: Quantidade de títulos incluídos
- `status`: Status do pedido (aberto, fechado)
- `data_criacao`: Data de criação

## 🎯 Como Usar

### 1. Importar XML
1. Acesse a aba "Importar XML"
2. Selecione o arquivo XML da NF-e
3. Informe o percentual de comissão (ex: 5.00 para 5%)
4. Clique em "Importar e Gerar Comissões"
5. O sistema irá:
   - Extrair dados da nota
   - Salvar a nota no banco
   - Criar títulos para cada duplicata
   - Calcular valores de comissão

### 2. Visualizar Títulos
1. Acesse a aba "Títulos de Comissão"
2. Veja todos os títulos gerados
3. Informações incluem:
   - Nota fiscal origem
   - Emitente
   - Duplicata
   - Valores
   - Status

### 3. Criar Pedido
1. Na aba "Títulos de Comissão"
2. Selecione os títulos desejados (checkbox)
3. Clique em "Criar Pedido com Selecionados"
4. Informe uma descrição
5. Confirme a criação
6. Os títulos serão vinculados ao pedido

### 4. Gerenciar Pedidos
1. Acesse a aba "Pedidos"
2. Visualize todos os pedidos criados
3. Clique em "Ver" para detalhes
4. Veja títulos incluídos no pedido

## 🔍 Validações Implementadas

- ✅ XML duplicado (por chave de acesso)
- ✅ Percentual de comissão (0.01% a 100%)
- ✅ Formato do arquivo (apenas .xml)
- ✅ Estrutura do XML (valida tags obrigatórias)
- ✅ Títulos já vinculados a pedidos

## 🎨 Interface

- Design moderno e responsivo
- Gradiente roxo/azul
- Cards informativos
- Tabelas organizadas
- Badges de status coloridos
- Mensagens de sucesso/erro
- Loading indicators

## 📦 Dependências

- **express**: Framework web
- **multer**: Upload de arquivos
- **xml2js**: Parser de XML
- **sqlite3**: Banco de dados

## 🔐 Segurança

- Upload apenas de arquivos XML
- Validação de estrutura do XML
- Sanitização de dados
- Prevenção de duplicatas

## 📈 Possíveis Melhorias Futuras

- Exportação de relatórios (PDF/Excel)
- Filtros avançados
- Busca de notas/títulos
- Edição de títulos
- Exclusão de pedidos
- Autenticação de usuários
- Histórico de alterações
- Integração com APIs de pagamento
- Notificações de vencimento
- Múltiplas empresas/filiais

## 🐛 Tratamento de Erros

- Arquivo XML inválido
- Nota já importada
- Percentual inválido
- Títulos já em pedido
- Erros de conexão

## 💡 Observações

- O banco SQLite é criado automaticamente
- Arquivos XML são salvos temporariamente durante processamento
- Sistema suporta estrutura padrão de NF-e 4.0
- Cálculos são feitos com 2 casas decimais

## 🤝 Suporte

Para dúvidas ou problemas, verifique:
1. Console do navegador (F12)
2. Logs do servidor Node.js
3. Arquivo commission.db (dados)

## 📝 Licença

MIT License
