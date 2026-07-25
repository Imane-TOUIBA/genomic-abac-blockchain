'use strict';
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect, hash } = require('@hyperledger/fabric-gateway');
const { newGrpcConnection, newIdentity, newSigner } = require('./connect');

const CHANNEL = 'global-channel';
const CHAINCODE = 'gouvernancecc';
const CONTRACT = 'AttestationContract';
const RESULTS_DIR = path.join(__dirname, '../../benchmark_results');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

const USERS = ['DrEinstein', 'DrCurie', 'DrSmith', 'DrTuring', 'DrPasteur', 'DrInactive', 'DrUnauthorized'];
const RESOURCES = ['o2b', 'o3c', 'o4d'];
const PATIENTS = ['alpha', 'beta', 'gamma', 'delta'];
const ACTIONS = ['Executer', 'Lire'];

// ---------- Arguments CLI ----------
// node benchmark_concurrent.js <totalRequests> <concurrency>
const totalRequests = parseInt(process.argv[2]) || 200;
const concurrency = parseInt(process.argv[3]) || 10;

function loadDirectory() {
    const data = fsSync.readFileSync(path.join(__dirname, 'directory.json'), 'utf-8');
    return JSON.parse(data);
}

function evaluatePrequester(directory, userId, projectId) {
    const user = directory[userId];
    if (!user) return { ok: false, reason: 'Utilisateur inconnu', clearance: null };
    if (!user.active) return { ok: false, reason: 'Compte inactif', clearance: null };
    if (!user.projects.includes(projectId)) return { ok: false, reason: 'Non autorise sur le projet', clearance: null };
    return { ok: true, reason: null, clearance: user.clearance };
}

async function newConnectedGateway() {
    const client = await newGrpcConnection();
    const gateway = connect({
        client: client,
        identity: await newIdentity(),
        signer: await newSigner(),
        hash: hash.sha256,
        evaluateOptions: function() { return { deadline: Date.now() + 5000 }; },
        endorseOptions: function() { return { deadline: Date.now() + 15000 }; },
        submitOptions: function() { return { deadline: Date.now() + 5000 }; },
        commitStatusOptions: function() { return { deadline: Date.now() + 60000 }; },
    });
    return { gateway, client };
}

async function submitAttestation(gateway, userId, resourceId, action, projectId, patientId, prequesterResult) {
    const network = gateway.getNetwork(CHANNEL);
    const contract = network.getContract(CHAINCODE, CONTRACT);

    // NONCE UNIQUE OBLIGATOIRE (anti-rejeu côté chaincode)
    const uniqueNonce = 'bench-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    const attestationId = crypto.createHash('sha256').update(uniqueNonce).digest('hex');

    const payload = {
        attestation_id: attestationId,
        requester_org: 'CGNMSP',
        user_id: userId,
        user_clearance: prequesterResult.clearance,
        resource_id: resourceId,
        owner_org: 'IBMSP',
        action: action,
        project_id: projectId,
        patient_id: patientId,
        prequester_ok: prequesterResult.ok,
        nonce: uniqueNonce,
        timestamp: new Date().toISOString()
    };

    const resultBytes = await contract.submitTransaction('SubmitAttestation', JSON.stringify(payload));
    return JSON.parse(new TextDecoder().decode(resultBytes));
}

// Un "worker" possède sa propre connexion gRPC/gateway, pour que la
// concurrence teste vraiment le réseau Fabric et non un seul canal partagé.
async function runWorker(workerId, directory, requestIds, logFile, results) {
    const { gateway, client } = await newConnectedGateway();

    for (const id of requestIds) {
        const userId = USERS[Math.floor(Math.random() * USERS.length)];
        const resourceId = RESOURCES[Math.floor(Math.random() * RESOURCES.length)];
        const patientId = PATIENTS[Math.floor(Math.random() * PATIENTS.length)];
        const action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];

        const reqStart = Date.now();
        let status = 'ERROR';
        let reason = '';

        try {
            const preq = evaluatePrequester(directory, userId, 'Oncologie');
            if (!preq.ok) {
                status = 'REJECTED_LOCAL';
                reason = preq.reason;
            } else {
                const result = await submitAttestation(gateway, userId, resourceId, action, 'Oncologie', patientId, preq);
                if (result.valid === true) {
                    status = 'PERMIT';
                    reason = '';
                } else {
                    status = 'DENY';
                    reason = result.deny_reason || 'Non specifie';
                }
            }
        } catch (error) {
            status = 'ERROR';
            reason = error.message;
        }

        const duration = Date.now() - reqStart;
        const record = { id, worker: workerId, duration, status, userId, resourceId, patientId, reason, startedAt: reqStart };
        results.push(record);
        fsSync.appendFileSync(
            logFile,
            [id, workerId, duration, status, userId, resourceId, patientId, '"' + reason.replace(/"/g, "'") + '"'].join(',') + '\n'
        );
        process.stdout.write('.'); // progression compacte pour ne pas noyer la console
    }

    gateway.close();
    client.close();
}

function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.ceil((p / 100) * sortedArr.length) - 1);
    return sortedArr[Math.max(0, idx)];
}

function stdDev(arr, mean) {
    if (arr.length < 2) return 0;
    const variance = arr.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
}

async function runBenchmark() {
    fsSync.mkdirSync(RESULTS_DIR, { recursive: true });
    const logFile = path.join(RESULTS_DIR, 'benchmark_concurrent_' + TIMESTAMP + '.csv');
    fsSync.writeFileSync(logFile, 'id,worker,duration_ms,status,user,resource,patient,reason\n');

    console.log('==========================================');
    console.log('Benchmark ABAC Genomic — mode concurrent');
    console.log('Date: ' + new Date().toLocaleString());
    console.log('Requetes totales: ' + totalRequests);
    console.log('Concurrence: ' + concurrency + ' clients simultanes');
    console.log('==========================================\n');

    if (totalRequests < 100) {
        console.log('⚠️  ATTENTION: avec moins de 100 requetes, les percentiles');
        console.log('   (P95, P99) et l\'ecart-type ne sont pas statistiquement fiables.');
        console.log('   Utilisez au moins --total 100, idealement 300-500.\n');
    }

    const directory = loadDirectory();

    // Répartir les IDs de requêtes entre les workers (round-robin)
    const workerBuckets = Array.from({ length: concurrency }, () => []);
    for (let i = 1; i <= totalRequests; i++) {
        workerBuckets[(i - 1) % concurrency].push(i);
    }

    const results = [];
    const wallStart = Date.now();

    console.log('Lancement de ' + concurrency + ' workers en parallele...\n');

    await Promise.all(
        workerBuckets.map((ids, workerId) => runWorker(workerId, directory, ids, logFile, results))
    );

    const wallTime = Date.now() - wallStart;

    console.log('\n');

    // ---------- Statistiques ----------
    const stats = {
        total: results.length,
        permit: results.filter(r => r.status === 'PERMIT').length,
        deny: results.filter(r => r.status === 'DENY').length,
        rejected_local: results.filter(r => r.status === 'REJECTED_LOCAL').length,
        error: results.filter(r => r.status === 'ERROR').length,
    };

    // Latence par type de requête : séparer le fail-fast local (quasi 0ms)
    // des vraies requêtes blockchain, sinon la moyenne globale est trompeuse.
    const chainDurations = results
        .filter(r => r.status === 'PERMIT' || r.status === 'DENY')
        .map(r => r.duration)
        .sort((a, b) => a - b);

    const allDurations = results.map(r => r.duration).sort((a, b) => a - b);

    const avgChain = chainDurations.length
        ? chainDurations.reduce((a, b) => a + b, 0) / chainDurations.length
        : 0;
    const sd = stdDev(chainDurations, avgChain);

    // Débit réel sous charge concurrente : requêtes traitées / temps mur total
    const throughput = stats.total / (wallTime / 1000);

    // Débit "utile" : uniquement les requêtes ayant atteint la blockchain
    const chainThroughput = chainDurations.length / (wallTime / 1000);

    console.log('==========================================');
    console.log('Resultats du Benchmark (mode concurrent)');
    console.log('==========================================');
    console.log('Temps mur total: ' + wallTime + 'ms (' + (wallTime / 1000).toFixed(2) + 's)');
    console.log('Concurrence utilisee: ' + concurrency + ' clients');
    console.log('Debit global: ' + throughput.toFixed(2) + ' requetes/seconde');
    console.log('Debit blockchain (PERMIT+DENY uniquement): ' + chainThroughput.toFixed(2) + ' requetes/seconde');

    console.log('\nDistribution des resultats:');
    console.log('  PERMIT: ' + stats.permit + ' (' + (stats.permit * 100 / stats.total).toFixed(1) + '%)');
    console.log('  DENY: ' + stats.deny + ' (' + (stats.deny * 100 / stats.total).toFixed(1) + '%)');
    console.log('  REJET LOCAL: ' + stats.rejected_local + ' (' + (stats.rejected_local * 100 / stats.total).toFixed(1) + '%)');
    console.log('  ERREURS: ' + stats.error + ' (' + (stats.error * 100 / stats.total).toFixed(1) + '%)');

    if (chainDurations.length > 0) {
        console.log('\nLatence des requetes blockchain (PERMIT+DENY), n=' + chainDurations.length + ':');
        console.log('  Minimum: ' + chainDurations[0] + 'ms');
        console.log('  Maximum: ' + chainDurations[chainDurations.length - 1] + 'ms');
        console.log('  Moyenne: ' + avgChain.toFixed(2) + 'ms  (ecart-type: ' + sd.toFixed(2) + 'ms)');
        console.log('  Median (P50): ' + percentile(chainDurations, 50) + 'ms');
        console.log('  P90: ' + percentile(chainDurations, 90) + 'ms');
        console.log('  P95: ' + percentile(chainDurations, 95) + 'ms');
        console.log('  P99: ' + percentile(chainDurations, 99) + 'ms');
    } else {
        console.log('\nAucune requete n\'a atteint la blockchain (toutes REJECTED_LOCAL ou ERROR).');
    }

    console.log('\nFichier de resultats: ' + logFile);
    console.log('==========================================');

    if (stats.error > 0) {
        console.log('\n⚠️  ' + stats.error + ' erreur(s) detectee(s). Raisons rencontrees :');
        const errorReasons = {};
        results.filter(r => r.status === 'ERROR').forEach(r => {
            errorReasons[r.reason] = (errorReasons[r.reason] || 0) + 1;
        });
        Object.entries(errorReasons).forEach(([reason, count]) => {
            console.log('  - (' + count + 'x) ' + reason);
        });
    }
}

runBenchmark().catch(function(err) {
    console.error('Erreur fatale:', err);
    process.exit(1);
});
