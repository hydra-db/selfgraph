import re
import sys
import unicodedata

import pytest
from helpers import new_graph, run

from selfgraph import _unicode, ids

AFTER_15_0 = ["\U0002ebf0", "\U0002ebf1", "\U000323b0", "\U00001c89", "\U0000a7cb"]


@pytest.mark.parametrize("char", AFTER_15_0)
def test_characters_added_after_unicode_15_0_are_dropped_from_ids_on_every_python(char):
    assert ids.entity_id("Person", f"王{char}") == "person:王"
    assert ids.entity_id("Person", f"Ann {char}x") == "person:ann-x"
    assert ids.normalize_rel_type(f"works{char}at") == "WORKS_AT"


def test_characters_added_in_unicode_14_0_and_15_0_stay_in_ids_on_every_python():
    assert ids.entity_id("Person", "王\U00031350") == "person:王\U00031350"
    assert ids.entity_id("Person", "Ⱟ") == "person:ⱟ"
    assert ids.normalize_rel_type("Ꟁ") == "Ꟁ"


def test_final_sigma_lowercases_the_same_way_in_ids():
    assert ids.entity_id("Person", "ΟΔΥΣΣΕΥΣ") == "person:οδυσσευς"
    assert ids.entity_id("Person", "ΑΣ ΣΑ") == "person:ας-σα"


@pytest.mark.parametrize("char", AFTER_15_0)
def test_retrieval_ignores_characters_added_after_unicode_15_0(char):
    g = new_graph()
    entity = run(g.entities.create("王", "Person"))
    assert [seed.id for seed in run(g.retrieve(f"王{char}")).seeds] == [entity.id]


def test_pinned_tables_match_the_unicode_15_0_data_of_python_3_12():
    if unicodedata.unidata_version != "15.0.0":
        pytest.skip("the tables are checked against the Unicode 15.0 data of Python 3.12")
    every = "".join(f"{chr(cp)}\n" for cp in [*range(0xD800), *range(0xE000, sys.maxunicode + 1)])
    assert _unicode.lower(every) == every.lower()
    assert _unicode.upper(every) == every.upper()
    assert _unicode.casefold(every) == every.casefold()
    for body, test in (
        (_unicode.LETTER_CLASS, str.isalpha),
        (_unicode.ALNUM_CLASS, str.isalnum),
        (_unicode.DECIMAL_CLASS, str.isdecimal),
    ):
        assert re.findall(f"[{body}]", every) == [ch for ch in every if test(ch) and ch != "\n"]


@pytest.mark.parametrize("char", AFTER_15_0)
def test_question_terms_keep_a_contraction_after_a_character_added_after_unicode_15_0(char):
    report = run(new_graph().check_answerable(f"{char}can't go"))
    assert [item.term for item in report.terms] == ["can't", "go"]
