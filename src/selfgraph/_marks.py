from __future__ import annotations

MARK_RANGES = (
    "300-36f 483-487 591-5bd 5bf 5c1-5c2 5c4-5c5 5c7 610-61a 64b-65f 670 6d6-6dc 6df-6e4 6e7-6e8 6ea-6ed 711 "
    "730-74a 7a6-7b0 7eb-7f3 7fd 816-819 81b-823 825-827 829-82d 859-85b 898-89f 8ca-8e1 8e3-903 93a-93c "
    "93e-94f 951-957 962-963 981-983 9bc 9be-9c4 9c7-9c8 9cb-9cd 9d7 9e2-9e3 9fe a01-a03 a3c a3e-a42 a47-a48 "
    "a4b-a4d a51 a70-a71 a75 a81-a83 abc abe-ac5 ac7-ac9 acb-acd ae2-ae3 afa-aff b01-b03 b3c b3e-b44 b47-b48 "
    "b4b-b4d b55-b57 b62-b63 b82 bbe-bc2 bc6-bc8 bca-bcd bd7 c00-c04 c3c c3e-c44 c46-c48 c4a-c4d c55-c56 "
    "c62-c63 c81-c83 cbc cbe-cc4 cc6-cc8 cca-ccd cd5-cd6 ce2-ce3 cf3 d00-d03 d3b-d3c d3e-d44 d46-d48 d4a-d4d "
    "d57 d62-d63 d81-d83 dca dcf-dd4 dd6 dd8-ddf df2-df3 e31 e34-e3a e47-e4e eb1 eb4-ebc ec8-ece f18-f19 f35 "
    "f37 f39 f3e-f3f f71-f84 f86-f87 f8d-f97 f99-fbc fc6 102b-103e 1056-1059 105e-1060 1062-1064 1067-106d "
    "1071-1074 1082-108d 108f 109a-109d 135d-135f 1712-1715 1732-1734 1752-1753 1772-1773 17b4-17d3 17dd "
    "180b-180d 180f 1885-1886 18a9 1920-192b 1930-193b 1a17-1a1b 1a55-1a5e 1a60-1a7c 1a7f 1ab0-1abd 1abf-1ace "
    "1b00-1b04 1b34-1b44 1b6b-1b73 1b80-1b82 1ba1-1bad 1be6-1bf3 1c24-1c37 1cd0-1cd2 1cd4-1ce8 1ced 1cf4 "
    "1cf7-1cf9 1dc0-1dff 20d0-20dc 20e1 20e5-20f0 2cef-2cf1 2d7f 2de0-2dff 302a-302f 3099-309a a66f a674-a67d "
    "a69e-a69f a6f0-a6f1 a802 a806 a80b a823-a827 a82c a880-a881 a8b4-a8c5 a8e0-a8f1 a8ff a926-a92d a947-a953 "
    "a980-a983 a9b3-a9c0 a9e5 aa29-aa36 aa43 aa4c-aa4d aa7b-aa7d aab0 aab2-aab4 aab7-aab8 aabe-aabf aac1 "
    "aaeb-aaef aaf5-aaf6 abe3-abea abec-abed fb1e fe20-fe2f 101fd 102e0 10376-1037a 10a01-10a03 10a05-10a06 "
    "10a0c-10a0f 10a38-10a3a 10a3f 10ae5-10ae6 10d24-10d27 10eab-10eac 10efd-10eff 10f46-10f50 10f82-10f85 "
    "11000-11002 11038-11046 11070 11073-11074 1107f-11082 110b0-110ba 110c2 11100-11102 11127-11134 "
    "11145-11146 11173 11180-11182 111b3-111c0 111c9-111cc 111ce-111cf 1122c-11237 1123e 11241 112df-112ea "
    "11300-11303 1133b-1133c 1133e-11344 11347-11348 1134b-1134d 11357 11362-11363 11366-1136c 11370-11374 "
    "11435-11446 1145e 114b0-114c3 115af-115b5 115b8-115c0 115dc-115dd 11630-11640 116ab-116b7 1171d-1172b "
    "1182c-1183a 11930-11935 11937-11938 1193b-1193e 11940 11942-11943 119d1-119d7 119da-119e0 119e4 "
    "11a01-11a0a 11a33-11a39 11a3b-11a3e 11a47 11a51-11a5b 11a8a-11a99 11c2f-11c36 11c38-11c3f 11c92-11ca7 "
    "11ca9-11cb6 11d31-11d36 11d3a 11d3c-11d3d 11d3f-11d45 11d47 11d8a-11d8e 11d90-11d91 11d93-11d97 "
    "11ef3-11ef6 11f00-11f01 11f03 11f34-11f3a 11f3e-11f42 13440 13447-13455 16af0-16af4 16b30-16b36 16f4f "
    "16f51-16f87 16f8f-16f92 16fe4 16ff0-16ff1 1bc9d-1bc9e 1cf00-1cf2d 1cf30-1cf46 1d165-1d169 1d16d-1d172 "
    "1d17b-1d182 1d185-1d18b 1d1aa-1d1ad 1d242-1d244 1da00-1da36 1da3b-1da6c 1da75 1da84 1da9b-1da9f "
    "1daa1-1daaf 1e000-1e006 1e008-1e018 1e01b-1e021 1e023-1e024 1e026-1e02a 1e08f 1e130-1e136 1e2ae "
    "1e2ec-1e2ef 1e4ec-1e4ef 1e8d0-1e8d6 1e944-1e94a"
)


FORMAT_RANGES = (
    "ad 600-605 61c 6dd 70f 890-891 8e2 180e 200b-200f 202a-202e 2060-2064 2066-206f feff fff9-fffb 110bd 110cd "
    "13430-1343f 1bca0-1bca3 1d173-1d17a e0001 e0020-e007f"
)


UPPERCASE_RANGES = (
    "41-5a c0-d6 d8-de 100 102 104 106 108 10a 10c 10e 110 112 114 116 118 11a 11c 11e 120 122 124 126 128 12a "
    "12c 12e 130 132 134 136 139 13b 13d 13f 141 143 145 147 14a 14c 14e 150 152 154 156 158 15a 15c 15e 160 "
    "162 164 166 168 16a 16c 16e 170 172 174 176 178-179 17b 17d 181-182 184 186-187 189-18b 18e-191 193-194 "
    "196-198 19c-19d 19f-1a0 1a2 1a4 1a6-1a7 1a9 1ac 1ae-1af 1b1-1b3 1b5 1b7-1b8 1bc 1c4 1c7 1ca 1cd 1cf 1d1 "
    "1d3 1d5 1d7 1d9 1db 1de 1e0 1e2 1e4 1e6 1e8 1ea 1ec 1ee 1f1 1f4 1f6-1f8 1fa 1fc 1fe 200 202 204 206 208 "
    "20a 20c 20e 210 212 214 216 218 21a 21c 21e 220 222 224 226 228 22a 22c 22e 230 232 23a-23b 23d-23e 241 "
    "243-246 248 24a 24c 24e 370 372 376 37f 386 388-38a 38c 38e-38f 391-3a1 3a3-3ab 3cf 3d2-3d4 3d8 3da 3dc "
    "3de 3e0 3e2 3e4 3e6 3e8 3ea 3ec 3ee 3f4 3f7 3f9-3fa 3fd-42f 460 462 464 466 468 46a 46c 46e 470 472 474 "
    "476 478 47a 47c 47e 480 48a 48c 48e 490 492 494 496 498 49a 49c 49e 4a0 4a2 4a4 4a6 4a8 4aa 4ac 4ae 4b0 "
    "4b2 4b4 4b6 4b8 4ba 4bc 4be 4c0-4c1 4c3 4c5 4c7 4c9 4cb 4cd 4d0 4d2 4d4 4d6 4d8 4da 4dc 4de 4e0 4e2 4e4 "
    "4e6 4e8 4ea 4ec 4ee 4f0 4f2 4f4 4f6 4f8 4fa 4fc 4fe 500 502 504 506 508 50a 50c 50e 510 512 514 516 518 "
    "51a 51c 51e 520 522 524 526 528 52a 52c 52e 531-556 10a0-10c5 10c7 10cd 13a0-13f5 1c90-1cba 1cbd-1cbf 1e00 "
    "1e02 1e04 1e06 1e08 1e0a 1e0c 1e0e 1e10 1e12 1e14 1e16 1e18 1e1a 1e1c 1e1e 1e20 1e22 1e24 1e26 1e28 1e2a "
    "1e2c 1e2e 1e30 1e32 1e34 1e36 1e38 1e3a 1e3c 1e3e 1e40 1e42 1e44 1e46 1e48 1e4a 1e4c 1e4e 1e50 1e52 1e54 "
    "1e56 1e58 1e5a 1e5c 1e5e 1e60 1e62 1e64 1e66 1e68 1e6a 1e6c 1e6e 1e70 1e72 1e74 1e76 1e78 1e7a 1e7c 1e7e "
    "1e80 1e82 1e84 1e86 1e88 1e8a 1e8c 1e8e 1e90 1e92 1e94 1e9e 1ea0 1ea2 1ea4 1ea6 1ea8 1eaa 1eac 1eae 1eb0 "
    "1eb2 1eb4 1eb6 1eb8 1eba 1ebc 1ebe 1ec0 1ec2 1ec4 1ec6 1ec8 1eca 1ecc 1ece 1ed0 1ed2 1ed4 1ed6 1ed8 1eda "
    "1edc 1ede 1ee0 1ee2 1ee4 1ee6 1ee8 1eea 1eec 1eee 1ef0 1ef2 1ef4 1ef6 1ef8 1efa 1efc 1efe 1f08-1f0f "
    "1f18-1f1d 1f28-1f2f 1f38-1f3f 1f48-1f4d 1f59 1f5b 1f5d 1f5f 1f68-1f6f 1fb8-1fbb 1fc8-1fcb 1fd8-1fdb "
    "1fe8-1fec 1ff8-1ffb 2102 2107 210b-210d 2110-2112 2115 2119-211d 2124 2126 2128 212a-212d 2130-2133 "
    "213e-213f 2145 2160-216f 2183 24b6-24cf 2c00-2c2f 2c60 2c62-2c64 2c67 2c69 2c6b 2c6d-2c70 2c72 2c75 "
    "2c7e-2c80 2c82 2c84 2c86 2c88 2c8a 2c8c 2c8e 2c90 2c92 2c94 2c96 2c98 2c9a 2c9c 2c9e 2ca0 2ca2 2ca4 2ca6 "
    "2ca8 2caa 2cac 2cae 2cb0 2cb2 2cb4 2cb6 2cb8 2cba 2cbc 2cbe 2cc0 2cc2 2cc4 2cc6 2cc8 2cca 2ccc 2cce 2cd0 "
    "2cd2 2cd4 2cd6 2cd8 2cda 2cdc 2cde 2ce0 2ce2 2ceb 2ced 2cf2 a640 a642 a644 a646 a648 a64a a64c a64e a650 "
    "a652 a654 a656 a658 a65a a65c a65e a660 a662 a664 a666 a668 a66a a66c a680 a682 a684 a686 a688 a68a a68c "
    "a68e a690 a692 a694 a696 a698 a69a a722 a724 a726 a728 a72a a72c a72e a732 a734 a736 a738 a73a a73c a73e "
    "a740 a742 a744 a746 a748 a74a a74c a74e a750 a752 a754 a756 a758 a75a a75c a75e a760 a762 a764 a766 a768 "
    "a76a a76c a76e a779 a77b a77d-a77e a780 a782 a784 a786 a78b a78d a790 a792 a796 a798 a79a a79c a79e a7a0 "
    "a7a2 a7a4 a7a6 a7a8 a7aa-a7ae a7b0-a7b4 a7b6 a7b8 a7ba a7bc a7be a7c0 a7c2 a7c4-a7c7 a7c9 a7d0 a7d6 a7d8 "
    "a7f5 ff21-ff3a 10400-10427 104b0-104d3 10570-1057a 1057c-1058a 1058c-10592 10594-10595 10c80-10cb2 "
    "118a0-118bf 16e40-16e5f 1d400-1d419 1d434-1d44d 1d468-1d481 1d49c 1d49e-1d49f 1d4a2 1d4a5-1d4a6 "
    "1d4a9-1d4ac 1d4ae-1d4b5 1d4d0-1d4e9 1d504-1d505 1d507-1d50a 1d50d-1d514 1d516-1d51c 1d538-1d539 "
    "1d53b-1d53e 1d540-1d544 1d546 1d54a-1d550 1d56c-1d585 1d5a0-1d5b9 1d5d4-1d5ed 1d608-1d621 1d63c-1d655 "
    "1d670-1d689 1d6a8-1d6c0 1d6e2-1d6fa 1d71c-1d734 1d756-1d76e 1d790-1d7a8 1d7ca 1e900-1e921 1f130-1f149 "
    "1f150-1f169 1f170-1f189"
)


def char_class(ranges: str) -> str:
    """Render space-separated hexadecimal code point ranges as the body of a regex character class.

    @param ranges (str): the ranges, each one code point or a first and last code point joined by a hyphen.
    @return (str): the class body, to place between square brackets.
    """
    parts = []
    for item in ranges.split():
        first, _, last = item.partition("-")
        parts.append("-".join(f"\\U{int(cp, 16):08x}" for cp in (first, last) if cp))
    return "".join(parts)


MARK_CLASS = char_class(MARK_RANGES)
FORMAT_CLASS = char_class(FORMAT_RANGES)
UPPERCASE_CLASS = char_class(UPPERCASE_RANGES)
