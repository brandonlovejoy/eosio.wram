import {Asset, Int64, Name} from '@wharfkit/antelope'
import {Blockchain, expectToThrow} from '@proton/vert'
import {describe, expect, test} from 'bun:test'

// Vert EOS VM
const blockchain = new Blockchain()
const alice = 'alice'
const bob = 'bob'
const charles = 'charles'
const system_accounts = ["eosio", "eosio.ram", "eosio.stake", "eosio.wrap", "eosio.token"]
const RAM_SYMBOL = "WRAM"
blockchain.createAccounts(bob, alice, charles, ...system_accounts)

const wram_contract = 'eosio.wram'
const contracts = {
    wram: blockchain.createContract(wram_contract, wram_contract, true),
    token: blockchain.createContract('eosio.token', 'include/eosio.token/eosio.token', true),
    system: blockchain.createContract('eosio', 'include/eosio.system/eosio', true),
    fake: {
        token: blockchain.createContract('fake.token', 'include/eosio.token/eosio.token', true),
        system: blockchain.createContract('fake', 'include/eosio.system/eosio', true),
    },
}

function getTokenBalance(account: string, symcode: string) {
    const scope = Name.from(account).value.value
    const primary_key = Asset.SymbolCode.from(symcode).value.value
    const row = contracts.wram.tables
        .accounts(scope)
        .getTableRow(primary_key)
    if (!row) return 0;
    return Asset.from(row.balance).units.toNumber()
}

function getTokenSupply(symcode: string) {
    const scope = Asset.SymbolCode.from(symcode).value.value
    const row = contracts.wram.tables
        .stat(scope)
        .getTableRow(scope)
    if (!row) return 0;
    return Asset.from(row.supply).units.toNumber()
}

function getRamBytes(account: string) {
    const scope = Name.from(account).value.value
    const row = contracts.system.tables
        .userres(scope)
        .getTableRow(scope)
    if (!row) return 0
    return Int64.from(row.ram_bytes).toNumber()
}

describe(wram_contract, () => {
    test('eosio::init', async () => {
        await contracts.system.actions.init([]).send()
    })

    test('eosio.token::issue::EOS', async () => {
        const supply = `1000000000.0000 EOS`
        await contracts.token.actions.create(['eosio.token', supply]).send()
        await contracts.token.actions.issue(['eosio.token', supply, '']).send()
        await contracts.token.actions.transfer(['eosio.token', alice, '1000.0000 EOS', '']).send()
        await contracts.token.actions.transfer(['eosio.token', bob, '1000.0000 EOS', '']).send()
        await contracts.token.actions.transfer(['eosio.token', charles, '1000.0000 EOS', '']).send()
    })

    test('eosio.token::issue::WRAM', async () => {
        const supply = `418945440768 ${RAM_SYMBOL}`
        await contracts.wram.actions.create([wram_contract, supply]).send()
    })

    test('eosio::buyrambytes', async () => {
        const before = getRamBytes(alice)
        await contracts.system.actions.buyrambytes([alice, alice, 10000]).send()
        const after = getRamBytes(alice)
        expect(after - before).toBe(10000)
    })

    test('eosio::ramtransfer', async () => {
        const before = getRamBytes(bob)
        await contracts.system.actions.ramtransfer([alice, bob, 5000, '']).send()
        const after = getRamBytes(bob)
        expect(after - before).toBe(5000)
    })

    test('fake::init', async () => {
        await contracts.fake.system.actions.init([]).send()
    });

    test('fake::buyrambytes', async () => {
        await contracts.fake.system.actions.buyrambytes([alice, alice, 10000]).send()
    })

    test('fake.token::issue::WRAM', async () => {
        const supply = `10000000000000 ${RAM_SYMBOL}`
        await contracts.fake.token.actions.create(['fake.token', supply]).send()
        await contracts.fake.token.actions.issue(['fake.token', supply, '']).send()
        await contracts.fake.token.actions.transfer(['fake.token', alice, `10000000 ${RAM_SYMBOL}`, '']).send()
    })

    test('on_notify::ramtransfer - wrap RAM bytes', async () => {
        const before = {
            wram_contract: {
                bytes: getRamBytes(wram_contract),
                RAM: getTokenBalance(wram_contract, RAM_SYMBOL),
                supply: getTokenSupply(RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        await contracts.system.actions.ramtransfer([alice, wram_contract, 1000, '']).send(alice)
        const after = {
            wram_contract: {
                bytes: getRamBytes(wram_contract),
                RAM: getTokenBalance(wram_contract, RAM_SYMBOL),
                supply: getTokenSupply(RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        // bytes
        expect(after.alice.bytes - before.alice.bytes).toBe(-1000)
        expect(after.wram_contract.bytes - before.wram_contract.bytes).toBe(1000)

        // RAM
        expect(after.alice.RAM - before.alice.RAM).toBe(1000)
        expect(after.wram_contract.RAM - before.wram_contract.RAM).toBe(0)
        expect(after.wram_contract.supply - before.wram_contract.supply).toBe(1000)
    })

    test('on_notify::buyrambytes - wrap RAM bytes', async () => {
        const before = {
            wram_contract: {
                bytes: getRamBytes(wram_contract),
                RAM: getTokenBalance(wram_contract, RAM_SYMBOL),
                supply: getTokenSupply(RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        await contracts.system.actions.buyrambytes([alice, wram_contract, 2000]).send(alice)
        const after = {
            wram_contract: {
                bytes: getRamBytes(wram_contract),
                RAM: getTokenBalance(wram_contract, RAM_SYMBOL),
                supply: getTokenSupply(RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        // bytes
        expect(after.alice.bytes - before.alice.bytes).toBe(0)
        expect(after.wram_contract.bytes - before.wram_contract.bytes).toBe(2000)

        // RAM
        expect(after.alice.RAM - before.alice.RAM).toBe(2000)
        expect(after.wram_contract.RAM - before.wram_contract.RAM).toBe(0)
        expect(after.wram_contract.supply - before.wram_contract.supply).toBe(2000)
    })

    test('transfer - unwrap WRAM', async () => {
        const before = {
            wram_contract: {
                bytes: getRamBytes(wram_contract),
                RAM: getTokenBalance(wram_contract, RAM_SYMBOL),
                supply: getTokenSupply(RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        await contracts.wram.actions.transfer([alice, wram_contract, `500 ${RAM_SYMBOL}`, '']).send(alice)
        const after = {
            wram_contract: {
                bytes: getRamBytes(wram_contract),
                RAM: getTokenBalance(wram_contract, RAM_SYMBOL),
                supply: getTokenSupply(RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        // bytes
        expect(after.alice.bytes - before.alice.bytes).toBe(+500)
        expect(after.wram_contract.bytes - before.wram_contract.bytes).toBe(-500)

        // RAM
        expect(after.alice.RAM - before.alice.RAM).toBe(-500)
        expect(after.wram_contract.RAM - before.wram_contract.RAM).toBe(0)
        expect(after.wram_contract.supply - before.wram_contract.supply).toBe(-500)
    })

    test('transfer - WRAM to another account', async () => {
        const before = {
            bob: {
                bytes: getRamBytes(bob),
                RAM: getTokenBalance(bob, RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }
        await contracts.wram.actions.transfer([alice, bob, `500 ${RAM_SYMBOL}`, '']).send(alice)
        const after = {
            bob: {
                bytes: getRamBytes(bob),
                RAM: getTokenBalance(bob, RAM_SYMBOL),
            },
            alice: {
                bytes: getRamBytes(alice),
                RAM: getTokenBalance(alice, RAM_SYMBOL),
            },
        }

        // bytes (no change)
        expect(after.alice.bytes - before.alice.bytes).toBe(0)
        expect(after.bob.bytes - before.bob.bytes).toBe(0)

        // RAM
        expect(after.alice.RAM - before.alice.RAM).toBe(-500)
        expect(after.bob.RAM - before.bob.RAM).toBe(+500)
    })

    test('transfer - ignore', async () => {
        const before = getTokenBalance(alice, RAM_SYMBOL);
        await contracts.system.actions.ramtransfer([alice, wram_contract, 1000, "ignore"]).send(alice)
        const after = getTokenBalance(alice, RAM_SYMBOL)
        expect(after - before).toBe(0)
    })

    test('transfer::error - cannot transfer to eosio.* accounts', async () => {
        for ( const to of system_accounts) {
            const action = contracts.wram.actions.transfer([alice, to, `1000 ${RAM_SYMBOL}`, '']).send(alice)
            await expectToThrow(action, 'eosio_assert: cannot transfer to eosio.* accounts')
        }
    })

    test('transfer::error - fake eosio.token WRAM', async () => {
        const action = contracts.fake.token.actions.transfer([alice, wram_contract, `1000 ${RAM_SYMBOL}`, '']).send(alice)
        await expectToThrow(action, 'eosio_assert_message: Only the eosio.wram contract may send tokens to this contract.')
    })

    test('transfer::error - fake eosio system RAM bytes', async () => {
        const before = getTokenBalance(alice, RAM_SYMBOL);
        await contracts.fake.system.actions.ramtransfer([alice, wram_contract, 1000, alice]).send(alice)
        const after = getTokenBalance(alice, RAM_SYMBOL)
        expect(after - before).toBe(0)
    })
})