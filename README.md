# ABAC Genomic: Prototype de contrôle d'accès décentralisé (Hyperledger Fabric 2.5)

Ce projet implémente un système de contrôle d'accès basé sur les attributs (ABAC) sur une infrastructure blockchain (Hyperledger Fabric) pour un consortium de recherche génomique multi-organisations. Il démontre qu'une décision d'accès n'est accordée que si trois politiques sont simultanément satisfaites :

```text
AccèsAutorisé = Prequester ∧ Ptrust ∧ Powner
```

- **Prequester** : règles internes du demandeur, évaluées localement (hors chaîne) par le PEP.
- **Ptrust** : existence d'une convention de collaboration valide entre organisations, évaluée sur la blockchain.
- **Powner** : règles du propriétaire de la ressource (habilitation, consentement patient), évaluées sur la blockchain.

Ce guide est conçu pour être suivi étape par étape sur une machine virtuelle (VM) Ubuntu 24.04 LTS. Il ne nécessite aucune connaissance préalable d'Hyperledger Fabric.

---

## Prérequis

- Une VM **Ubuntu 24.04 LTS** avec les droits `sudo`. Les tests ont été validés sur une VM configurée avec **10 Go de RAM** et **200 Go d'espace disque**.
- Une connexion internet active.

---

## Étape 1 : Installation de l'environnement système

Ouvrez un terminal sur votre VM et exécutez les commandes suivantes les unes après les autres.

### 1.1. Mise à jour et installation des outils de base
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git vim unzip software-properties-common \
  apt-transport-https ca-certificates gnupg lsb-release build-essential
```

### 1.2. Installation de Docker
Docker permet de lancer les nœuds de la blockchain (peers, orderer) dans des conteneurs isolés.
```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Ajouter votre utilisateur au groupe docker pour éviter d'utiliser 'sudo' à chaque fois
sudo usermod -aG docker $USER
newgrp docker
```

### 1.3. Installation de Go (Langage des chaincodes)
```bash
cd /tmp
wget https://go.dev/dl/go1.22.5.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.22.5.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin' >> ~/.bashrc
source ~/.bashrc
```

### 1.4. Installation de Node.js (Pour les services applicatifs)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 1.5. Installation des binaires Hyperledger Fabric
Cette commande télécharge uniquement les outils nécessaires (`peer`, `cryptogen`, etc.) et le fichier de configuration de base.
```bash
cd ~
curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh | bash -s -- binary

# Ajouter les binaires au PATH système
echo 'export PATH=$HOME/bin:$PATH' >> ~/.bashrc
echo 'export FABRIC_CFG_PATH=$HOME/config' >> ~/.bashrc
source ~/.bashrc
```

### 1.6. Vérification
Assurez-vous que tout est bien installé en exécutant :
```bash
docker --version
go version
node --version
peer version
```
*(Si `peer version` affiche un numéro de version, vous êtes prêt pour la suite).*

---

## Étape 2 : Récupération du projet

### 2.1. Cloner le dépôt
```bash
cd ~
git clone https://github.com/Imane-TOUIBA/genomic-abac-blockchain.git abac-genomic
cd abac-genomic
```

### 2.2. Rendre les scripts exécutables
```bash
chmod +x setup_all.sh init_network.sh
```

---

## Étape 3 : Démarrage du réseau Blockchain

### 3.1. Générer les certificats et lancer les conteneurs
```bash
cd ~/abac-genomic
./setup_all.sh
```
*Ce script prend quelques minutes. Il génère les identités cryptographiques, crée les canaux et démarre les conteneurs Docker.*

### 3.2. Vérification
```bash
docker ps --filter "name=peer" --filter "name=orderer"
```
**Résultat attendu :** Vous devez voir 4 conteneurs avec le statut `Up` :
- `orderer.example.com`
- `peer0.cgn.example.com`
- `peer0.ib.example.com`
- `peer0.hu.example.com`

---

## Étape 4 : Déploiement des Chaincodes

Les chaincodes sont le code métier qui s'exécute sur la blockchain.

### 4.0. Définir les variables globales
Copiez ce bloc une seule fois. Il définit les chemins vers les certificats et les adresses des nœuds.
```bash
cd ~/abac-genomic
export PATH=$HOME/bin:$PATH
export FABRIC_CFG_PATH=$PWD/config
export CORE_PEER_TLS_ENABLED=true

ORDERER_CA="$PWD/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"

PEER_CGN="localhost:7051"
TLS_CGN="$PWD/organizations/peerOrganizations/cgn.example.com/peers/peer0.cgn.example.com/tls/ca.crt"

PEER_IBM="localhost:9051"
TLS_IBM="$PWD/organizations/peerOrganizations/ib.example.com/peers/peer0.ib.example.com/tls/ca.crt"

PEER_HU="localhost:11051"
TLS_HU="$PWD/organizations/peerOrganizations/hu.example.com/peers/peer0.hu.example.com/tls/ca.crt"

# Attendre que les peers initialisent complètement leurs connexions TLS
echo "Attente de 15 secondes pour l'initialisation des peers..."
sleep 15
```

### 4.1. Déploiement de `consentcc` (Canal global)
Gère les consentements des patients.

```bash
# 1. Construction de l'image Docker et packaging
cd ~/abac-genomic/chaincodes/consentcc
docker build -t consentcc_ccaas_image:latest .
echo '{"address":"consentcc_ccaas:9999","dial_timeout":"10s","tls_required":false}' > connection.json
echo '{"type":"ccaas","label":"consentcc_1.0"}' > metadata.json
tar -czf code.tar.gz connection.json
tar -czvf ~/abac-genomic/consentcc_ccaas.tar.gz metadata.json code.tar.gz
cd ~/abac-genomic

CONSENT_PKG_ID=$(peer lifecycle chaincode calculatepackageid consentcc_ccaas.tar.gz)

# 2. Installation et 3. Approbation sur les 3 organisations
for ORG in CGNMSP IBMSP HUMSP; do
    export CORE_PEER_LOCALMSPID=$ORG
    if [ "$ORG" == "CGNMSP" ]; then export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp; fi
    if [ "$ORG" == "IBMSP" ]; then export CORE_PEER_ADDRESS=$PEER_IBM; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_IBM; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/ib.example.com/users/Admin@ib.example.com/msp; fi
    if [ "$ORG" == "HUMSP" ]; then export CORE_PEER_ADDRESS=$PEER_HU; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_HU; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/hu.example.com/users/Admin@hu.example.com/msp; fi
    peer lifecycle chaincode install consentcc_ccaas.tar.gz
    peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --channelID global-channel --name consentcc --version 1.0 --package-id $CONSENT_PKG_ID --sequence 1 --tls --cafile $ORDERER_CA --peerAddresses $CORE_PEER_ADDRESS --tlsRootCertFiles $CORE_PEER_TLS_ROOTCERT_FILE
done

# 4. Commit final (exécuté par CGNMSP)
export CORE_PEER_LOCALMSPID=CGNMSP; export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --channelID global-channel --name consentcc --version 1.0 --sequence 1 --tls --cafile $ORDERER_CA --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU

# 5. Lancement du conteneur d'exécution
docker run --rm -d --name consentcc_ccaas --network abac-genomic_test -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 -e CORE_CHAINCODE_ID_NAME="$CONSENT_PKG_ID" consentcc_ccaas_image:latest
```

### 4.2. Déploiement de `gouvernancecc` (Canal global)
Gère les ressources, les conventions et les attestations.

```bash
# 1. Construction et packaging
cd ~/abac-genomic/chaincodes/gouvernancecc
docker build -t gouvernancecc_ccaas_image:latest .
echo '{"address":"gouvernancecc_ccaas:9999","dial_timeout":"10s","tls_required":false}' > connection.json
echo '{"type":"ccaas","label":"gouvernancecc_1.0"}' > metadata.json
tar -czf code.tar.gz connection.json
tar -czvf ~/abac-genomic/gouvernancecc_ccaas.tar.gz metadata.json code.tar.gz
cd ~/abac-genomic

GOUV_PKG_ID=$(peer lifecycle chaincode calculatepackageid gouvernancecc_ccaas.tar.gz)

# 2. Installation et 3. Approbation (Boucle sur les 3 orgs)
for ORG in CGNMSP IBMSP HUMSP; do
    export CORE_PEER_LOCALMSPID=$ORG
    if [ "$ORG" == "CGNMSP" ]; then export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp; fi
    if [ "$ORG" == "IBMSP" ]; then export CORE_PEER_ADDRESS=$PEER_IBM; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_IBM; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/ib.example.com/users/Admin@ib.example.com/msp; fi
    if [ "$ORG" == "HUMSP" ]; then export CORE_PEER_ADDRESS=$PEER_HU; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_HU; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/hu.example.com/users/Admin@hu.example.com/msp; fi
    peer lifecycle chaincode install gouvernancecc_ccaas.tar.gz
    peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --channelID global-channel --name gouvernancecc --version 1.0 --package-id $GOUV_PKG_ID --sequence 1 --tls --cafile $ORDERER_CA --peerAddresses $CORE_PEER_ADDRESS --tlsRootCertFiles $CORE_PEER_TLS_ROOTCERT_FILE
done

# 4. Commit final
export CORE_PEER_LOCALMSPID=CGNMSP; export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --channelID global-channel --name gouvernancecc --version 1.0 --sequence 1 --tls --cafile $ORDERER_CA --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU

# 5. Lancement du conteneur
docker run --rm -d --name gouvernancecc_ccaas --network abac-genomic_test -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 -e CORE_CHAINCODE_ID_NAME="$GOUV_PKG_ID" gouvernancecc_ccaas_image:latest
```

### 4.3. Déploiement de `policycc` (Canal project-channel)
Gère les politiques d'accès fines. *Attention : HU n'est pas membre de ce canal.*

```bash
# 1. Construction et packaging
cd ~/abac-genomic/chaincodes/policycc
docker build -t policycc_ccaas_image:latest .
echo '{"address":"policycc_ccaas:9999","dial_timeout":"10s","tls_required":false}' > connection.json
echo '{"type":"ccaas","label":"policycc_1.0"}' > metadata.json
tar -czf code.tar.gz connection.json
tar -czvf ~/abac-genomic/policycc_ccaas.tar.gz metadata.json code.tar.gz
cd ~/abac-genomic

POLICY_PKG_ID=$(peer lifecycle chaincode calculatepackageid policycc_ccaas.tar.gz)

# 2. Installation et 3. Approbation (Uniquement CGN et IBM)
for ORG in CGNMSP IBMSP; do
    export CORE_PEER_LOCALMSPID=$ORG
    if [ "$ORG" == "CGNMSP" ]; then export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp; fi
    if [ "$ORG" == "IBMSP" ]; then export CORE_PEER_ADDRESS=$PEER_IBM; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_IBM; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/ib.example.com/users/Admin@ib.example.com/msp; fi
    peer lifecycle chaincode install policycc_ccaas.tar.gz
    peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --channelID project-channel --name policycc --version 1.0 --package-id $POLICY_PKG_ID --sequence 1 --tls --cafile $ORDERER_CA --peerAddresses $CORE_PEER_ADDRESS --tlsRootCertFiles $CORE_PEER_TLS_ROOTCERT_FILE
done

# 4. Commit final (Uniquement CGN et IBM)
export CORE_PEER_LOCALMSPID=CGNMSP; export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --channelID project-channel --name policycc --version 1.0 --sequence 1 --tls --cafile $ORDERER_CA --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM

# 5. Lancement du conteneur
docker run --rm -d --name policycc_ccaas --network abac-genomic_test -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 -e CORE_CHAINCODE_ID_NAME="$POLICY_PKG_ID" policycc_ccaas_image:latest
```

### 4.4. Vérification du déploiement
```bash
docker ps | grep ccaas
```
**Résultat attendu :** 3 conteneurs doivent être `Up` : `consentcc_ccaas`, `gouvernancecc_ccaas`, `policycc_ccaas`.

---

## Étape 5 : Initialisation des données du Ledger

Le ledger (registre de la blockchain) est vide à sa création. Nous allons y inscrire manuellement les données de notre scénario de test.

```bash
cd ~/abac-genomic

# 1. Enregistrer la ressource "o2b" (par IBMSP)
export CORE_PEER_LOCALMSPID=IBMSP; export CORE_PEER_ADDRESS=$PEER_IBM; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_IBM; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/ib.example.com/users/Admin@ib.example.com/msp
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA -C global-channel -n gouvernancecc --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU --waitForEvent -c '{"function":"AttestationContract:RegisterResource","Args":["o2b", "IBMSP", "true", "Oncologie"]}'

# 2. Enregistrer la convention IBMSP -> CGNMSP (par IBMSP)
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA -C global-channel -n gouvernancecc --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU --waitForEvent -c '{"function":"TrustContract:RegisterConvention","Args":["IBMSP", "CGNMSP", "Oncologie", "2030-12-31T23:59:59Z"]}'

# 3. Enregistrer le consentement du patient alpha (par CGNMSP)
export CORE_PEER_LOCALMSPID=CGNMSP; export CORE_PEER_ADDRESS=$PEER_CGN; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA -C global-channel -n consentcc --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU --waitForEvent -c '{"function":"RegisterConsent","Args":["alpha", "CGNMSP", "o2b", "Oncologie", "2030-12-31"]}'

# 4. Enregistrer la politique d'accès pour "o2b" (par IBMSP sur project-channel)
export CORE_PEER_LOCALMSPID=IBMSP; export CORE_PEER_ADDRESS=$PEER_IBM; export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_IBM; export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/ib.example.com/users/Admin@ib.example.com/msp
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA -C project-channel -n policycc --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --waitForEvent -c '{"function":"RegisterResourcePolicy","Args":["o2b", "IBMSP", "[\"IBMSP\",\"CGNMSP\"]", "[\"Executer\",\"Lire\"]", "elevee", "00:00", "23:59"]}'
```
**Résultat attendu :** Chaque commande doit se terminer par `Chaincode invoke successful. result: status:200`.

---

## Étape 6 : Installation des services Node.js

Les services applicatifs (PEP, Relais, Portail) nécessitent l'installation de leurs dépendances.

```bash
cd ~/abac-genomic/services/pep-service && npm install
cd ~/abac-genomic/services/relay-service && npm install
cd ~/abac-genomic/services/consent-portal && npm install
```

---

## Étape 7 : Test de bout en bout (Scénario Flux 2)

Pour tester le système, nous devons lancer le service "Relais" en arrière-plan, puis soumettre une demande via le service "PEP".

### 7.1. Lancer le Relais (Terminal 1)
Ouvrez un premier terminal :
```bash
cd ~/abac-genomic/services/relay-service
killall node 2>/dev/null || true
node relay.js
```
*Le terminal doit afficher qu'il écoute les événements. Laissez-le tourner.*

### 7.2. Soumettre une demande d'accès (Terminal 2)
Ouvrez un **deuxième terminal** :
```bash
cd ~/abac-genomic/services/pep-service

# Cas 1 : Accès autorisé (DrEinstein a l'habilitation requise)
node submit_access_request.js DrEinstein o2b Executer Oncologie alpha
```

**Résultats attendus :**
- **Terminal PEP :** Doit afficher `Validité globale : true` et `Attestation validée !`.
- **Terminal Relais :** Doit afficher `[relay] décision enregistrée : PERMIT`.

### 7.3. Tester les cas de refus
Dans le Terminal 2, testez les autres scénarios :
```bash
# Cas 2 : Habilitation insuffisante (DrSmith n'a pas le niveau 'elevee')
node submit_access_request.js DrSmith o2b Executer Oncologie alpha
# Résultat attendu : DENY (la requête atteint la blockchain mais est refusée)

# Cas 3 : Rejet local (DrUnauthorized n'est pas sur le projet Oncologie)
node submit_access_request.js DrUnauthorized o2b Executer Oncologie alpha
# Résultat attendu : REJET LOCAL (fail-fast, aucune requête envoyée à la blockchain)
```

---

## Étape 8 : Tester le cycle de vie complet d'un consentement

Ce test valide l'enregistrement, la vérification et la révocation dynamique des consentements via l'API.

### 8.1. Démarrer le portail de consentement
```bash
cd ~/abac-genomic/services/consent-portal
killall node 2>/dev/null || true
node server.js &
sleep 3
```

### 8.2. Appels pour enregistrer, vérifier et révoquer un consentement
```bash
# 1. Enregistrer un consentement
curl -X POST http://localhost:3000/api/consent \
  -H "Content-Type: application/json" \
  -d '{"patientId":"patient_test","orgId":"CGNMSP","resourceId":"o2b","projectId":"Oncologie","expiresAt":"2030-12-31"}'
# Attendu : {"success":true,"message":"Consentement enregistré sur le ledger."}

# 2. Vérifier qu'il est valide
curl "http://localhost:3000/api/consent?patientId=patient_test&orgId=CGNMSP&resourceId=o2b&projectId=Oncologie"
# Attendu : {"success":true,"data":{"isValid":true}}

# 3. Révoquer le consentement
curl -X DELETE http://localhost:3000/api/consent \
  -H "Content-Type: application/json" \
  -d '{"patientId":"patient_test","orgId":"CGNMSP","resourceId":"o2b","projectId":"Oncologie"}'
# Attendu : {"success":true,"message":"Consentement révoqué avec succès sur le ledger."}

# 4. Vérifier qu'il est bien invalide
curl "http://localhost:3000/api/consent?patientId=patient_test&orgId=CGNMSP&resourceId=o2b&projectId=Oncologie"
# Attendu : {"success":true,"data":{"isValid":false}}
```
*Note : Le portail se connecte avec l'identité `CGNMSP`. Le chaincode refuse volontairement toute tentative d'une organisation d'enregistrer un consentement au nom d'une autre.*

---

## Étape 9 : Benchmark de performance (avec concurrence)

Le script ci-dessous envoie les requêtes par lots concurrents, avec plusieurs connexions Fabric indépendantes, ce qui permet de mesurer un débit sous charge et de repérer un point de saturation.

> ⚠️ **Limites à connaître avant d'interpréter les résultats** : le prototype comporte un seul peer par organisation et un seul orderer, sans redondance. Le script client tourne sur la même machine que les conteneurs Fabric (pas de latence réseau réelle, ressources CPU partagées). Les chiffres obtenus caractérisent donc la capacité de cette topologie minimale colocalisée, pas une capacité de production distribuée.

### 9.1. Enrichir les données de test

### 9.1. Enrichir les données de test

Exécutez ce bloc pour créer un annuaire d'utilisateurs varié et ajouter les ressources et patients supplémentaires sur la blockchain. 

> ⚠️ **Note importante :** Ce script change automatiquement d'identité (IBMSP pour les ressources, CGNMSP pour les consentements) afin d'éviter les erreurs d'endorsement. Assurez-vous de l'exécuter depuis la racine du projet.

```bash
cd ~/abac-genomic

# 1. Créer le répertoire local des utilisateurs de test
cat << 'EOF' > services/pep-service/directory.json
{
  "DrEinstein": { "active": true, "role": "senior_researcher", "clearance": "elevee", "projects": ["Oncologie", "Cardio"] },
  "DrCurie": { "active": true, "role": "senior_researcher", "clearance": "elevee", "projects": ["Oncologie"] },
  "Darwin": { "active": true, "role": "senior_researcher", "clearance": "elevee", "projects": ["Genomique"] },
  "DrSmith": { "active": true, "role": "researcher", "clearance": "standard", "projects": ["Oncologie"] },
  "DrTuring": { "active": true, "role": "researcher", "clearance": "standard", "projects": ["Oncologie", "Genomique"] },
  "DrPasteur": { "active": true, "role": "researcher", "clearance": "standard", "projects": ["Cardio"] },
  "DrInactive": { "active": false, "role": "researcher", "clearance": "standard", "projects": ["Oncologie"] },
  "DrUnauthorized": { "active": true, "role": "researcher", "clearance": "standard", "projects": ["Cardio"] }
}
EOF

# 2. Définir les variables d'environnement de base
export PATH=$HOME/bin:$PATH
export FABRIC_CFG_PATH=$PWD/config
export CORE_PEER_TLS_ENABLED=true
export ORDERER_CA=$PWD/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem

PEER_CGN="localhost:7051"
TLS_CGN="$PWD/organizations/peerOrganizations/cgn.example.com/peers/peer0.cgn.example.com/tls/ca.crt"
PEER_IBM="localhost:9051"
TLS_IBM="$PWD/organizations/peerOrganizations/ib.example.com/peers/peer0.ib.example.com/tls/ca.crt"
PEER_HU="localhost:11051"
TLS_HU="$PWD/organizations/peerOrganizations/hu.example.com/peers/peer0.hu.example.com/tls/ca.crt"

# 3. Enregistrer les nouvelles ressources o3c, o4d (EN TANT QUE IBMSP - PROPRIÉTAIRE)
export CORE_PEER_LOCALMSPID=IBMSP
export CORE_PEER_ADDRESS=$PEER_IBM
export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_IBM
export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/ib.example.com/users/Admin@ib.example.com/msp

for res in "o3c" "o4d"; do
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA -C global-channel -n gouvernancecc --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU --waitForEvent -c "{\"function\":\"AttestationContract:RegisterResource\",\"Args\":[\"$res\", \"IBMSP\", \"true\", \"Oncologie\"]}"
done

# 4. Enregistrer les consentements pour de nouveaux patients (EN TANT QUE CGNMSP)
export CORE_PEER_LOCALMSPID=CGNMSP
export CORE_PEER_ADDRESS=$PEER_CGN
export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CGN
export CORE_PEER_MSPCONFIGPATH=$PWD/organizations/peerOrganizations/cgn.example.com/users/Admin@cgn.example.com/msp

for patient in "beta" "gamma" "delta"; do
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile $ORDERER_CA -C global-channel -n consentcc --peerAddresses $PEER_CGN --tlsRootCertFiles $TLS_CGN --peerAddresses $PEER_IBM --tlsRootCertFiles $TLS_IBM --peerAddresses $PEER_HU --tlsRootCertFiles $TLS_HU --waitForEvent -c "{\"function\":\"RegisterConsent\",\"Args\":[\"$patient\",\"CGNMSP\",\"o2b\",\"Oncologie\",\"2030-12-31\"]}"
done

echo "✅ Données enrichies avec succès."

### 9.2. Le script de benchmark concurrent

Créez le fichier `benchmark_concurrent.js` dans le service PEP.

> ⚠️ **Point critique — nonce unique obligatoire.** Le chaincode `gouvernancecc` (`attestation_contract.go`) rejette toute transaction dont le champ `nonce` a déjà été vu (protection anti-rejeu). Sans ce champ, la première requête passe puis toutes les suivantes échouent avec `chaincode response 500, nonce déjà utilisé`. Le script génère un nonce unique à chaque requête — c'est indispensable pour obtenir 0 % d'erreurs.


### 9.3. Exécuter le benchmark

Syntaxe : `node benchmark_concurrent.js <nombre_total_requetes> <concurrence>`

```bash
cd ~/abac-genomic/services/pep-service

# Test vérifier que ça tourne sans erreur
node benchmark_concurrent.js 20 3

# Puis monter progressivement en charge pour chercher le point de saturation
node benchmark_concurrent.js 100 5
node benchmark_concurrent.js 100 10
node benchmark_concurrent.js 100 30
node benchmark_concurrent.js 100 80
```

Un fichier CSV détaillé est généré à chaque exécution dans
`~/abac-genomic/benchmark_results/`, au format :

```csv
id,worker,duration_ms,status,user,resource,patient,reason
1,0,2145,PERMIT,DrEinstein,o2b,alpha,""
2,1,0,REJECTED_LOCAL,DrInactive,o3c,beta,"Compte inactif"
3,2,2234,DENY,DrSmith,o4d,gamma,"POWNER_FAIL : Habilitation insuffisante"
```
---

## Dépannage (FAQ)

**1. Erreur `permission denied` avec Docker**
Si `docker ps` renvoie une erreur, déconnectez-vous et reconnectez-vous à votre session utilisateur, ou exécutez `newgrp docker`.

**2. Erreur `context deadline exceeded` lors du déploiement**
Les peers mettent du temps à initialiser leurs certificats TLS. Si cela arrive, attendez 30 secondes et relancez la commande qui a échoué.

**3. Erreur `ERR_REQUIRE_ESM` avec Node.js**
Si vous rencontrez cette erreur lors du lancement des services Node.js, cela signifie qu'une version incompatible du SDK a été installée. Corrigez cela en forçant la version stable dans chaque dossier de service :
```bash
cd ~/abac-genomic/services/relay-service
rm -rf node_modules package-lock.json
npm install @hyperledger/fabric-gateway@1.5.1
# Répétez l'opération pour pep-service et consent-portal si nécessaire
```

**4. Erreur `chaincode response 500, nonce déjà utilisé` pendant le benchmark**
Le champ `nonce` du payload n'est pas unique. Vérifiez que vous utilisez bien la version du script `benchmark_concurrent.js` fournie ci-dessus, qui génère un nonce unique (`'bench-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex')`) à chaque requête. Ce bug provient d'une vérification anti-rejeu dans `chaincodes/gouvernancecc/attestation_contract.go`.

**5. Pourquoi les données du ledger sont-elles perdues après un redémarrage ?**
La blockchain garantit l'immuabilité et la persistance des données tant que le réseau est actif. Cependant, dans cet environnement de test, les nœuds (peers et orderer) tournent dans des conteneurs Docker éphémères. Si ces conteneurs sont détruits (par exemple via la commande `docker compose down -v` qui supprime les volumes de stockage associés), la copie locale du ledger (les blocs et la base de données d'état) est effacée. Pour récupérer un état fonctionnel, il suffit de relancer les commandes de l'**Étape 5** après avoir redémarré le réseau.

---

## Documentation et Références

Pour approfondir les concepts d'Hyperledger Fabric, des chaincodes et de l'architecture des canaux, consultez la documentation officielle :
- [Documentation officielle Hyperledger Fabric](https://hyperledger-fabric.readthedocs.io/en/latest/)
- [Guide du développeur de chaincodes (Go)](https://hyperledger-fabric.readthedocs.io/en/latest/chaincode4ade.html)
