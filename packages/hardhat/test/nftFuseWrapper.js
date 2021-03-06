const fs = require('fs')
const chalk = require('chalk')
const { config, ethers } = require('hardhat')
const { utils, BigNumber: BN } = ethers
const { use, expect } = require('chai')
const { solidity } = require('ethereum-waffle')
const n = require('eth-ens-namehash')
const namehash = n.hash
const { loadENSContract } = require('../utils/contracts')

use(solidity)

const labelhash = (label) => utils.keccak256(utils.toUtf8Bytes(label))
const ROOT_NODE =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

const addresses = {}

async function deploy(name, _args) {
  const args = _args || []

  console.log(`📄 ${name}`)
  const contractArtifacts = await ethers.getContractFactory(name)
  const contract = await contractArtifacts.deploy(...args)
  console.log(chalk.cyan(name), 'deployed to:', chalk.magenta(contract.address))
  fs.writeFileSync(`artifacts/${name}.address`, contract.address)
  console.log('\n')
  contract.name = name
  addresses[name] = contract.address
  return contract
}

describe('NFT fuse wrapper', () => {
  let ENSRegistry
  let BaseRegistrar
  let RestrictedNameWrapper
  let PublicResolver
  let SubDomainRegistrar

  before(async () => {
    const [owner] = await ethers.getSigners()
    const registryJSON = loadENSContract('ens', 'ENSRegistry')
    const baseRegistrarJSON = loadENSContract(
      'ethregistrar',
      'BaseRegistrarImplementation'
    )
    const controllerJSON = loadENSContract(
      'ethregistrar',
      'ETHRegistrarController'
    )
    const dummyOracleJSON = loadENSContract('ethregistrar', 'DummyOracle')
    const linearPremiumPriceOracleJSON = loadENSContract(
      'ethregistrar',
      'LinearPremiumPriceOracle'
    )

    const registryContractFactory = new ethers.ContractFactory(
      registryJSON.abi,
      registryJSON.bytecode,
      owner
    )
    EnsRegistry = await registryContractFactory.deploy()

    try {
      const rootOwner = await EnsRegistry.owner(ROOT_NODE)
    } catch (e) {
      console.log('failing on rootOwner', e)
    }
    console.log('succeeded on root owner')
    const account = await owner.getAddress()

    BaseRegistrar = await new ethers.ContractFactory(
      baseRegistrarJSON.abi,
      baseRegistrarJSON.bytecode,
      owner
    ).deploy(EnsRegistry.address, namehash('eth'))

    console.log(`*** BaseRegistrar deployed at ${BaseRegistrar.address} *** `)

    await BaseRegistrar.addController(account)

    RestrictedNameWrapper = await deploy('RestrictedNameWrapper', [
      EnsRegistry.address,
      BaseRegistrar.address,
    ])

    PublicResolver = await deploy('PublicResolver', [
      EnsRegistry.address,
      addresses['RestrictedNameWrapper'],
    ])

    SubDomainRegistrar = await deploy('SubdomainRegistrar', [
      EnsRegistry.address,
      addresses['RestrictedNameWrapper'],
    ])

    // setup .eth
    await EnsRegistry.setSubnodeOwner(
      ROOT_NODE,
      utils.keccak256(utils.toUtf8Bytes('eth')),
      account
    )

    // give .eth back to registrar

    // make base registrar owner of eth
    await EnsRegistry.setSubnodeOwner(
      ROOT_NODE,
      labelhash('eth'),
      BaseRegistrar.address
    )

    const ethOwner = await EnsRegistry.owner(namehash('eth'))
    const ensEthOwner = await EnsRegistry.owner(namehash('ens.eth'))

    console.log('ethOwner', ethOwner)
    console.log('ensEthOwner', ensEthOwner)

    console.log(
      'ens.setApprovalForAll RestrictedNameWrapper',
      account,
      addresses['RestrictedNameWrapper']
    )

    console.log(
      'ens.setApprovalForAll SubDomainRegistrar',
      SubDomainRegistrar.address,
      true
    )
    await EnsRegistry.setApprovalForAll(SubDomainRegistrar.address, true)

    console.log(
      'RestrictedNameWrapper.setApprovalForAll SubDomainRegistrar',
      SubDomainRegistrar.address,
      true
    )
    await RestrictedNameWrapper.setApprovalForAll(
      SubDomainRegistrar.address,
      true
    )

    //make sure base registrar is owner of eth TLD

    const ownerOfEth = await EnsRegistry.owner(namehash('eth'))

    expect(ownerOfEth).to.equal(BaseRegistrar.address)
  })

  describe('RestrictedNameWrapper', () => {
    it('wrap() wraps a name with the ERC721 standard and fuses', async () => {
      const [signer] = await ethers.getSigners()
      const account = await signer.getAddress()

      await BaseRegistrar.register(labelhash('wrapped'), account, 84600)
      await EnsRegistry.setApprovalForAll(RestrictedNameWrapper.address, true)
      await RestrictedNameWrapper.wrap(
        namehash('eth'),
        labelhash('wrapped'),
        255,
        account
      )
      const ownerOfWrappedEth = await RestrictedNameWrapper.ownerOf(
        namehash('wrapped.eth')
      )
      expect(ownerOfWrappedEth).to.equal(account)
    })

    it('wrap2Ld() wraps a name with the ERC721 standard and fuses', async () => {
      const [signer] = await ethers.getSigners()
      const account = await signer.getAddress()

      await BaseRegistrar.register(labelhash('wrapped2'), account, 84600)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(RestrictedNameWrapper.address, true)

      await RestrictedNameWrapper.wrapETH2LD(
        labelhash('wrapped2'),
        255,
        account
      )

      //make sure reclaim claimed ownership for the wrapper in registry
      const ownerInRegistry = await EnsRegistry.owner(namehash('wrapped2.eth'))

      expect(ownerInRegistry).to.equal(RestrictedNameWrapper.address)

      //make sure owner in the wrapper is the user
      const ownerOfWrappedEth = await RestrictedNameWrapper.ownerOf(
        namehash('wrapped2.eth')
      )

      expect(ownerOfWrappedEth).to.equal(account)

      // make sure registrar ERC721 is owned by Wrapper
      const ownerInRegistrar = await BaseRegistrar.ownerOf(
        labelhash('wrapped2')
      )

      expect(ownerInRegistrar).to.equal(RestrictedNameWrapper.address)

      // make sure it can't be unwrapped
      const canUnwrap = await RestrictedNameWrapper.canUnwrap(
        namehash('wrapped2.eth')
      )
    })

    it('can send ERC721 token to restricted wrapper', async () => {
      const [signer] = await ethers.getSigners()
      const account = await signer.getAddress()
      const tokenId = labelhash('send2contract')
      const wrappedTokenId = namehash('send2contract.eth')

      await BaseRegistrar.register(tokenId, account, 84600)

      const ownerInRegistrar = await BaseRegistrar.ownerOf(tokenId)

      await BaseRegistrar['safeTransferFrom(address,address,uint256)'](
        account,
        RestrictedNameWrapper.address,
        tokenId
      )

      const ownerInWrapper = await RestrictedNameWrapper.ownerOf(wrappedTokenId)

      expect(ownerInWrapper).to.equal(account)
    })

    it('can set fuses and burn canSetData', async () => {
      const [signer] = await ethers.getSigners()
      const account = await signer.getAddress()
      const tokenId = labelhash('fuses1')
      const wrappedTokenId = namehash('fuses1.eth')
      const CAN_DO_EVERYTHING = 0
      const CANNOT_UNWRAP = await RestrictedNameWrapper.CANNOT_UNWRAP()

      await BaseRegistrar.register(tokenId, account, 84600)

      await RestrictedNameWrapper.wrapETH2LD(
        tokenId,
        CAN_DO_EVERYTHING | CANNOT_UNWRAP,
        account
      )

      const CANNOT_SET_DATA = await RestrictedNameWrapper.CANNOT_SET_DATA()

      await RestrictedNameWrapper.burnFuses(
        namehash('eth'),
        tokenId,
        CAN_DO_EVERYTHING | CANNOT_SET_DATA
      )

      const ownerInWrapper = await RestrictedNameWrapper.ownerOf(wrappedTokenId)

      expect(ownerInWrapper).to.equal(account)

      // check flag in the wrapper
      const canSetData = await RestrictedNameWrapper.canSetData(wrappedTokenId)

      expect(canSetData).to.equal(false)

      //try to set the resolver and ttl
      expect(
        RestrictedNameWrapper.setResolver(wrappedTokenId, account)
      ).to.be.revertedWith('revert Fuse already blown for setting resolver')

      expect(
        RestrictedNameWrapper.setTTL(wrappedTokenId, 1000)
      ).to.be.revertedWith('revert Fuse already blown for setting TTL')
    })

    it('can set fuses and burn canCreateSubdomains', async () => {
      const [signer] = await ethers.getSigners()
      const account = await signer.getAddress()
      const tokenId = labelhash('fuses2')
      const wrappedTokenId = namehash('fuses2.eth')
      const CAN_DO_EVERYTHING = 0
      const CANNOT_UNWRAP = await RestrictedNameWrapper.CANNOT_UNWRAP()
      const CANNOT_REPLACE_SUBDOMAIN = await RestrictedNameWrapper.CANNOT_REPLACE_SUBDOMAIN()
      const CANNOT_CREATE_SUBDOMAIN = await RestrictedNameWrapper.CANNOT_CREATE_SUBDOMAIN()

      await BaseRegistrar.register(tokenId, account, 84600)

      await RestrictedNameWrapper.wrapETH2LD(
        tokenId,
        CAN_DO_EVERYTHING | CANNOT_UNWRAP | CANNOT_REPLACE_SUBDOMAIN,
        account
      )

      const canCreateSubdomain1 = await RestrictedNameWrapper.canCreateSubdomain(
        wrappedTokenId
      )

      expect(canCreateSubdomain1, 'createSubdomain is set to false').to.equal(
        true
      )

      console.log('canCreateSubdomain before burning', canCreateSubdomain1)

      // can create before burn

      //revert not approved and isn't sender because subdomain isnt owned by contract?
      await RestrictedNameWrapper.setSubnodeOwnerAndWrap(
        wrappedTokenId,
        labelhash('creatable'),
        account,
        255
      )

      expect(
        await RestrictedNameWrapper.ownerOf(namehash('creatable.fuses2.eth'))
      ).to.equal(account)

      await RestrictedNameWrapper.burnFuses(
        namehash('eth'),
        tokenId,
        CAN_DO_EVERYTHING | CANNOT_CREATE_SUBDOMAIN
      )

      const ownerInWrapper = await RestrictedNameWrapper.ownerOf(wrappedTokenId)

      expect(ownerInWrapper).to.equal(account)

      const canCreateSubdomain = await RestrictedNameWrapper.canCreateSubdomain(
        wrappedTokenId
      )

      expect(canCreateSubdomain).to.equal(false)

      //try to create a subdomain

      expect(
        RestrictedNameWrapper.setSubnodeOwner(
          namehash('fuses2.eth'),
          labelhash('uncreateable'),
          account
        )
      ).to.be.revertedWith(
        'revert The fuse has been burned for creating or replace a subdomain'
      )

      //expect replacing subdomain to succeed
    })
  })
})
// TODO move these tests to separate repo
// describe('SubDomainRegistrar configureDomain', () => {
//   it('Should be able to configure a new domain', async () => {
//     const [owner] = await ethers.getSigners()
//     const account = await owner.getAddress()
//     await BaseRegistrar.register(labelhash('vitalik'), account, 84600)
//     await SubDomainRegistrar.configureDomain(
//       namehash('eth'),
//       labelhash('vitalik'),
//       '1000000',
//       0
//     )

//     // TODO: assert vitalik.eth has been configured
//   })

//   it('Should be able to configure a new domain and then register', async () => {
//     const [signer] = await ethers.getSigners()
//     const account = await signer.getAddress()

//     await BaseRegistrar.register(labelhash('ens'), account, 84600)

//     await SubDomainRegistrar.configureDomain(
//       namehash('eth'),
//       labelhash('ens'),
//       '1000000',
//       0
//     )

//     const tx = PublicResolver.interface.encodeFunctionData(
//       'setAddr(bytes32,uint256,bytes)',
//       [namehash('awesome.ens.eth'), 60, account]
//     )

//     await SubDomainRegistrar.register(
//       namehash('ens.eth'),
//       'awesome',
//       account,
//       account,
//       addresses['PublicResolver'],
//       [tx],
//       {
//         value: '1000000',
//       }
//     )
//   })

//   it('Should be able to configure a new domain and then register fails because namehash does not match', async () => {
//     const [signer] = await ethers.getSigners()
//     const account = await signer.getAddress()

//     const tx = PublicResolver.interface.encodeFunctionData(
//       'setAddr(bytes32,uint256,bytes)',
//       [namehash('awesome.ens.eth'), 60, account]
//     )

//     //should fail as tx is not correct
//     await expect(
//       SubDomainRegistrar.register(
//         namehash('ens.eth'),
//         'othername',
//         account,
//         account,
//         addresses['PublicResolver'],
//         [tx],
//         {
//           value: '1000000',
//         }
//       )
//     ).to.be.revertedWith('revert invalid node for multicall')
//   })
// })